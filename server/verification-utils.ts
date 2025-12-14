import { db } from "./db";
import { verificationCodes } from "@shared/schema";
import { sql } from "drizzle-orm";
import { Client } from "ssh2";
import sgMail from "@sendgrid/mail";
import crypto from "crypto";

// Initialize SendGrid with API key
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@example.com";

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log("[Email] SendGrid initialized");
}

/**
 * Generate a random 6-digit verification code
 */
export function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate a secure random URL token (32 hex characters)
 * Used for one-click SMS verification links
 */
export function generateUrlToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// SMS Gateway Configuration (internal endpoint via jump server)
const SMS_API_HOST = process.env.SMS_API_HOST || "civtldocker02.herringbank.com";
const SMS_API_PORT = parseInt(process.env.SMS_API_PORT || "9191", 10);
const SMS_API_PATH = process.env.SMS_API_PATH || "/sms";
const SMS_TENANT_ID = process.env.SMS_TENANT_ID || "default";
const SMS_TENANT_APP_KEY = process.env.SMS_TENANT_APP_KEY;
const SMS_PROVIDER_ID = process.env.SMS_PROVIDER_ID || "4";

// SSH tunnel configuration (reuse ERPIS jump server settings)
const SMS_JUMP_SERVER = process.env.SMS_JUMP_SERVER || process.env.ERPIS_JUMP_SERVER;
const SMS_SSH_USER = process.env.SMS_SSH_USER || process.env.ERPIS_SSH_USER || "ec2-user";
const SMS_SSH_KEY = process.env.SMS_SSH_KEY || process.env.ERPIS_SSH_KEY;
const SMS_SSH_PORT = parseInt(process.env.SMS_SSH_PORT || process.env.ERPIS_SSH_PORT || "22", 10);

// Singleton SSH client for SMS
let smsClient: Client | null = null;
let smsConnected = false;
let smsConnectionPromise: Promise<Client> | null = null;

/**
 * Check if internal SMS gateway is configured
 */
function hasInternalSmsConfig(): boolean {
  return !!(SMS_JUMP_SERVER && SMS_SSH_KEY && SMS_TENANT_APP_KEY);
}

/**
 * Get SSH connection for SMS gateway
 */
async function getSmsSSHConnection(): Promise<Client> {
  if (smsClient && smsConnected) {
    return smsClient;
  }

  if (smsConnectionPromise) {
    return smsConnectionPromise;
  }

  if (!SMS_JUMP_SERVER || !SMS_SSH_KEY) {
    throw new Error("SMS SSH credentials not configured");
  }

  let privateKey: Buffer;
  try {
    privateKey = Buffer.from(SMS_SSH_KEY, "base64");
  } catch {
    throw new Error("Invalid SMS SSH key format - must be base64 encoded");
  }

  smsConnectionPromise = new Promise<Client>((resolve, reject) => {
    const client = new Client();

    client.on("ready", () => {
      console.log("[SMS] SSH connection established to jump server");
      smsClient = client;
      smsConnected = true;
      smsConnectionPromise = null;
      resolve(client);
    });

    client.on("error", (err) => {
      console.error("[SMS] SSH connection error:", err.message);
      smsConnected = false;
      smsClient = null;
      smsConnectionPromise = null;
      reject(err);
    });

    client.on("close", () => {
      console.log("[SMS] SSH connection closed");
      smsConnected = false;
      smsClient = null;
    });

    console.log(`[SMS] Connecting to jump server ${SMS_JUMP_SERVER}:${SMS_SSH_PORT} as ${SMS_SSH_USER}`);

    client.connect({
      host: SMS_JUMP_SERVER,
      port: SMS_SSH_PORT,
      username: SMS_SSH_USER,
      privateKey,
      readyTimeout: 30000,
      keepaliveInterval: 10000,
    });
  });

  return smsConnectionPromise;
}

/**
 * Make POST request through SSH tunnel to SMS gateway
 */
function sendSmsThroughTunnel(
  client: Client,
  targetHost: string,
  targetPort: number,
  requestPath: string,
  headers: Record<string, string>,
  body: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("SMS request timed out after 30 seconds"));
    }, 30000);

    client.forwardOut(
      "127.0.0.1",
      0,
      targetHost,
      targetPort,
      (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          console.error("[SMS] SSH forwardOut error:", err.message);
          reject(err);
          return;
        }

        const requestLines = [
          `POST ${requestPath} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
          `Content-Length: ${Buffer.byteLength(body)}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          "Connection: close",
          "",
          body,
        ];
        const requestData = requestLines.join("\r\n");

        console.log("[SMS] Sending HTTP request through tunnel...");

        let responseData = "";

        stream.on("data", (data: Buffer) => {
          responseData += data.toString();
          console.log(`[SMS] Received ${data.length} bytes`);
        });

        stream.on("end", () => {
          clearTimeout(timeout);
          console.log(`[SMS] Stream ended. Total response: ${responseData.length} bytes`);
          console.log(`[SMS] Raw response preview: ${responseData.substring(0, 300)}`);
          
          // Try both \r\n\r\n and \n\n as separators
          let headerEndIndex = responseData.indexOf("\r\n\r\n");
          let separatorLen = 4;
          
          if (headerEndIndex === -1) {
            headerEndIndex = responseData.indexOf("\n\n");
            separatorLen = 2;
          }
          
          if (headerEndIndex === -1) {
            // If no separator found but we have data, assume it's all body
            if (responseData.length > 0) {
              console.log("[SMS] No HTTP header separator found, treating entire response as body");
              resolve({ statusCode: 200, body: responseData });
            } else {
              reject(new Error("Empty response from SMS gateway"));
            }
            return;
          }

          const headerPart = responseData.substring(0, headerEndIndex);
          const bodyPart = responseData.substring(headerEndIndex + separatorLen);

          const statusMatch = headerPart.match(/^HTTP\/\d\.\d (\d{3})/);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;

          console.log(`[SMS] Parsed response - Status: ${statusCode}, Body length: ${bodyPart.length}`);
          resolve({ statusCode, body: bodyPart });
        });

        stream.on("close", () => {
          clearTimeout(timeout);
          console.log("[SMS] Stream closed");
          // If we haven't resolved yet and have data, try to parse it
          if (responseData.length > 0) {
            console.log(`[SMS] Processing response on close: ${responseData.substring(0, 200)}`);
            resolve({ statusCode: 200, body: responseData });
          }
        });

        stream.on("error", (streamErr: Error) => {
          clearTimeout(timeout);
          console.error("[SMS] Stream error:", streamErr.message);
          reject(streamErr);
        });

        stream.write(requestData);
      }
    );
  });
}

/**
 * Send SMS message via internal gateway through SSH tunnel
 */
export async function sendSMS(to: string, message: string): Promise<boolean> {
  if (!hasInternalSmsConfig()) {
    console.log("=============================================");
    console.log("📱 MOCK SMS SERVICE - MESSAGE NOT ACTUALLY SENT");
    console.log(`To: ${to}`);
    console.log(`Message: ${message}`);
    console.log("=============================================");
    console.log("To enable real SMS, set: SMS_TENANT_APP_KEY, and ensure ERPIS_JUMP_SERVER + ERPIS_SSH_KEY are configured");
    return true;
  }

  try {
    // Format phone number - remove + prefix and any non-digits for the API
    const mobileNumber = to.replace(/\D/g, "");
    
    // Generate a unique internal ID for tracking
    const internalId = Date.now().toString();

    const payload = JSON.stringify([
      {
        internalId,
        mobileNumber,
        smsMessage: message,
        providerId: SMS_PROVIDER_ID,
        type: "SMS"
      }
    ]);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "TenantId": SMS_TENANT_ID,
      "Tenant-App-Key": SMS_TENANT_APP_KEY!,
    };

    console.log(`[SMS] Sending SMS to ${mobileNumber} via internal gateway`);
    console.log(`[SMS] Target: ${SMS_API_HOST}:${SMS_API_PORT}${SMS_API_PATH}`);

    const client = await getSmsSSHConnection();
    const { statusCode, body } = await sendSmsThroughTunnel(
      client,
      SMS_API_HOST,
      SMS_API_PORT,
      SMS_API_PATH,
      headers,
      payload
    );

    console.log(`[SMS] Response status: ${statusCode}`);
    console.log(`[SMS] Response body: ${body.substring(0, 200)}`);

    if (statusCode >= 200 && statusCode < 300) {
      console.log(`[SMS] Successfully sent SMS to ${mobileNumber}`);
      return true;
    } else {
      console.error(`[SMS] Failed to send SMS: ${statusCode} - ${body}`);
      return false;
    }
  } catch (error) {
    console.error("[SMS] Error sending SMS:", error);
    
    // Reset SSH connection on error
    if (smsClient) {
      try {
        smsClient.end();
      } catch {
        // Ignore cleanup errors
      }
      smsClient = null;
      smsConnected = false;
    }

    return false;
  }
}

/**
 * Send email message via SendGrid
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.log("=============================================");
    console.log("📧 MOCK EMAIL SERVICE - MESSAGE NOT ACTUALLY SENT");
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${body}`);
    console.log("=============================================");
    console.log("To enable real email, set SENDGRID_API_KEY environment variable");
    return true;
  }

  try {
    console.log(`[Email] Sending email to ${to} via SendGrid`);
    
    await sgMail.send({
      to,
      from: SENDGRID_FROM_EMAIL,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });
    
    console.log(`[Email] Successfully sent email to ${to}`);
    return true;
  } catch (error: any) {
    console.error("[Email] Error sending email:", error?.response?.body || error.message);
    return false;
  }
}

/**
 * Mask a mobile number showing only the last 3 digits
 * Example: "+12345678901" -> "***-***-8901"
 */
export function maskMobileNumber(mobile: string): string {
  if (!mobile || mobile.length < 3) {
    return "***";
  }
  const last3 = mobile.slice(-3);
  return `***-***-${last3}`;
}

/**
 * Mask an email address showing first char, last char before @, and domain
 * Example: "john.doe@parisjc.edu" -> "j***e@parisjc.edu"
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) {
    return "***@***.***";
  }
  
  const [localPart, domain] = email.split("@");
  if (localPart.length === 0) {
    return `***@${domain}`;
  }
  
  const firstChar = localPart[0];
  const lastChar = localPart[localPart.length - 1];
  
  if (localPart.length === 1) {
    return `${firstChar}@${domain}`;
  }
  
  return `${firstChar}***${lastChar}@${domain}`;
}

/**
 * Normalize a mobile number by removing non-digits and ensuring proper format
 * Handles US, Canada, and international numbers
 */
export function normalizeMobileNumber(input: string): string {
  if (!input) {
    throw new Error("Mobile number cannot be empty");
  }
  
  // Remove all non-digit characters
  const digits = input.replace(/\D/g, "");
  
  if (digits.length === 0) {
    throw new Error("Mobile number must contain digits");
  }
  
  // Too short to be a valid mobile number
  if (digits.length < 10) {
    throw new Error("Mobile number too short");
  }
  
  // Handle US/Canada 10-digit numbers (add +1 prefix)
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // Handle 11-digit numbers
  if (digits.length === 11) {
    // US/Canada numbers start with 1
    if (digits.startsWith("1")) {
      return `+${digits}`;
    }
    // Other 11-digit international numbers (e.g., Russia +7, etc.)
    return `+${digits}`;
  }
  
  // Handle longer international numbers (12+ digits)
  // Just prepend + and return
  return `+${digits}`;
}

/**
 * Create and store a verification code in the database
 * @param studentId - The student's ID
 * @param type - Type of verification: "sms" or "email"
 * @param urlToken - Optional URL token for one-click SMS verification
 * @returns The generated verification code
 */
export async function createVerificationCode(
  studentId: string,
  type: "sms" | "email",
  urlToken?: string
): Promise<string> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
  
  await db.insert(verificationCodes).values({
    studentId,
    code,
    type,
    expiresAt,
    verified: false,
    urlToken: urlToken || null,
  });
  
  return code;
}

/**
 * Verify a code entered by the student
 */
export async function verifyCode(
  studentId: string,
  code: string,
  type: "sms" | "email"
): Promise<boolean> {
  // In development, accept "123456" as a universal code
  const isDevelopment = process.env.NODE_ENV === 'development';
  if (isDevelopment && code === '123456') {
    console.log(`🔓 DEV MODE: Accepting default code "123456" for ${type} verification`);
    return true;
  }
  
  const result = await db
    .select()
    .from(verificationCodes)
    .where(sql`${verificationCodes.studentId} = ${studentId}
      AND ${verificationCodes.code} = ${code}
      AND ${verificationCodes.type} = ${type}
      AND ${verificationCodes.verified} = false
      AND ${verificationCodes.expiresAt} > NOW()`)
    .limit(1);
  
  if (result.length === 0) {
    return false;
  }
  
  // Mark code as verified
  await db
    .update(verificationCodes)
    .set({ verified: true })
    .where(sql`${verificationCodes.id} = ${result[0].id}`);
  
  return true;
}
