import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2, Phone, RefreshCw } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { PageHeader } from "@/components/page-header";
import { StudentAccountMenu } from "@/components/student-account-menu";
import { VerificationProgressSteps } from "@/components/verification-progress-steps";
import { deriveVerificationProgress, getCurrentStepFromPath } from "@/lib/verification-utils";
import { useVerificationStepNavigation } from "@/hooks/use-verification-step-navigation";
import type { Student } from "@shared/schema";

export default function VerifyMobileCode() {
  const { studentId } = useParams<{ studentId: string }>();
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  
  // Track whether we should wait for manual code entry
  // This prevents auto-navigation when user is re-verifying
  const initialVerifiedStateRef = useRef<boolean | null>(null);
  const hasNavigatedRef = useRef(false);

  // Fetch student data for college info
  const { data: student } = useQuery<Student & { college?: { id: string; name: string; logoUrl: string | null; backgroundImageUrl: string | null } }>({
    queryKey: ["/api/student", studentId],
  });

  // Fetch contact verification status - poll every 2 seconds to detect SMS link verification
  const { data: contactData } = useQuery<{
    contacts: { mobile?: string; email?: string };
    mobileVerified: boolean;
    emailVerified: boolean;
  }>({
    queryKey: [`/api/student/${studentId}/verification-contacts`],
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  });

  // Capture initial verified state on first contactData load
  useEffect(() => {
    if (contactData && initialVerifiedStateRef.current === null) {
      initialVerifiedStateRef.current = contactData.mobileVerified ?? false;
      console.log("[VerifyMobileCode] Initial mobileVerified state:", initialVerifiedStateRef.current);
    }
  }, [contactData]);

  // Auto-navigate only when phone verification status CHANGES from false to true
  // This allows detection of SMS link verification while preventing auto-skip on re-verification
  useEffect(() => {
    // Don't navigate if we already did, or if we don't have data yet
    if (hasNavigatedRef.current || !contactData || initialVerifiedStateRef.current === null) {
      return;
    }
    
    // Only auto-navigate if:
    // 1. Initially was NOT verified (false)
    // 2. Now IS verified (true)
    // This means verification happened during this session (via SMS link click)
    if (initialVerifiedStateRef.current === false && contactData.mobileVerified === true) {
      hasNavigatedRef.current = true;
      // Only show toast if debug flag is enabled
      if (student?.debug) {
        toast({
          title: "Mobile verified!",
          description: "Your mobile number has been verified successfully",
        });
      }
      navigate(`/student/${studentId}/verify-email`);
    }
  }, [contactData?.mobileVerified, student?.debug, studentId, navigate, toast]);

  // Send verification code
  const sendCode = useMutation({
    mutationFn: async () => {
      return apiRequest(`/api/student/${studentId}/verify/send`, {
        method: "POST",
        body: JSON.stringify({ type: "sms" }),
      });
    },
    onSuccess: () => {
      toast({
        title: "Code sent!",
        description: "Check your mobile device for the verification code",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to send code",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  // Verify code
  const verifyCode = useMutation({
    mutationFn: async () => {
      return apiRequest(`/api/student/${studentId}/verify`, {
        method: "POST",
        body: JSON.stringify({ code, type: "sms" }),
      });
    },
    onSuccess: async () => {
      // Invalidate and refetch both queries to ensure fresh data
      await queryClient.invalidateQueries({ queryKey: ["/api/student", studentId] });
      await queryClient.invalidateQueries({ queryKey: [`/api/student/${studentId}/verification-contacts`] });
      
      // Wait for refetch to complete
      await queryClient.refetchQueries({ queryKey: ["/api/student", studentId] });
      
      // Only show toast if debug flag is enabled
      if (student?.debug) {
        toast({
          title: "Mobile verified!",
          description: "Your mobile number has been verified successfully",
        });
      }
      
      // Continue to email verification
      navigate(`/student/${studentId}/verify-email`);
    },
    onError: (error: any) => {
      toast({
        title: "Verification failed",
        description: error.message || "Invalid or expired code",
        variant: "destructive",
      });
    },
  });

  // Auto-send code on mount (use sessionStorage to prevent duplicate sends in React Strict Mode)
  useEffect(() => {
    const storageKey = `sms_code_sent_${studentId}`;
    const sentTime = sessionStorage.getItem(storageKey);
    const now = Date.now();
    
    // Only send if we haven't sent in the last 5 seconds (prevents Strict Mode double-send)
    if (!sentTime || now - parseInt(sentTime) > 5000) {
      sessionStorage.setItem(storageKey, now.toString());
      sendCode.mutate();
    }
  }, [studentId]);

  // Auto-submit when 6 digits are entered
  useEffect(() => {
    if (code.length === 6) {
      verifyCode.mutate();
    }
  }, [code]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length === 6) {
      verifyCode.mutate();
    }
  };

  // Calculate verification progress
  const completedSteps = deriveVerificationProgress(student);
  // Current step is determined by the route
  const currentStep = getCurrentStepFromPath(location);
  const handleStepNavigate = useVerificationStepNavigation(studentId, currentStep, completedSteps);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader 
        collegeName={student?.college?.name}
        collegeLogo={student?.college?.logoUrl || undefined}
        studentId={studentId}
        studentNumber={student?.studentNumber}
      >
        <StudentAccountMenu collegeLogo={student?.college?.logoUrl} collegeName={student?.college?.name} studentNumber={student?.studentNumber} />
      </PageHeader>

      {/* Mobile: Collapsible Progress Menu */}
      <div className="lg:hidden border-b bg-background">
        <div className="max-w-md mx-auto px-4 py-4">
          <VerificationProgressSteps 
            currentStep={currentStep} 
            completedSteps={completedSteps} 
            collapsible={true}
            studentId={studentId}
            onNavigate={handleStepNavigate}
            student={student}
          />
        </div>
      </div>

      <div className="flex max-w-6xl mx-auto p-4 py-8 gap-8">
        {/* Desktop: Sidebar Progress */}
        <div className="hidden lg:block w-64 flex-shrink-0">
          <div className="sticky top-8">
            <h3 className="text-sm font-semibold text-muted-foreground mb-4">Verification Steps</h3>
            <VerificationProgressSteps 
              currentStep={currentStep} 
              completedSteps={completedSteps}
              studentId={studentId}
              onNavigate={handleStepNavigate}
              student={student}
            />
          </div>
        </div>

        <div className="flex-1 max-w-2xl mx-auto">
        <Card>
        <CardHeader className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Phone className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-2xl">Enter Verification Code</CardTitle>
          </div>
          <CardDescription>
            We sent a 6-digit code to your mobile device
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                autoFocus
                data-testid="input-verification-code"
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={code.length !== 6 || verifyCode.isPending}
              data-testid="button-verify-code"
            >
              {verifyCode.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                "Verify Code"
              )}
            </Button>
          </form>

          <div className="text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendCode.mutate()}
              disabled={sendCode.isPending}
              data-testid="button-resend-code"
            >
              {sendCode.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Resend Code
                </>
              )}
            </Button>
          </div>

          <p className="text-sm text-center text-muted-foreground">
            Code expires in 10 minutes
          </p>
        </CardContent>
      </Card>
        </div>
      </div>
    </div>
  );
}
