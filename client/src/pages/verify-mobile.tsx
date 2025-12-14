import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AlertCircle, CheckCircle2, Loader2, Phone, Smartphone, Monitor } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { StudentAccountMenu } from "@/components/student-account-menu";
import { VerificationProgressSteps } from "@/components/verification-progress-steps";
import { deriveVerificationProgress, getCurrentStepFromPath } from "@/lib/verification-utils";
import { useVerificationStepNavigation } from "@/hooks/use-verification-step-navigation";
import { DeviceHandoffDialog, isPCSessionActive } from "@/components/device-handoff-dialog";
import { useDeviceDetection } from "@/hooks/use-device-upload";
import type { Student } from "@shared/schema";

export default function VerifyMobile() {
  const { studentId } = useParams<{ studentId: string }>();
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const [maskedMobile, setMaskedMobile] = useState("");
  const [showHandoffDialog, setShowHandoffDialog] = useState(false);
  
  // Detect if current device is mobile
  const { isMobile } = useDeviceDetection();
  
  // Track whether we should auto-navigate when verification completes via SMS link
  const initialVerifiedStateRef = useRef<boolean | null>(null);
  const hasNavigatedRef = useRef(false);

  // Fetch student data for college info
  const { data: student } = useQuery<Student & { college?: { id: string; name: string; logoUrl: string | null; backgroundImageUrl: string | null } }>({
    queryKey: ["/api/student", studentId],
    refetchInterval: isMobile ? 3000 : false,
  });

  // Fetch masked contact info - poll every 2 seconds to detect SMS link verification
  const { data: contactData, isLoading, isError, error } = useQuery<{
    contacts: { mobile?: string; email?: string };
    mobileVerified: boolean;
    emailVerified: boolean;
  }>({
    queryKey: [`/api/student/${studentId}/verification-contacts`],
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error: any) => {
      // Don't retry on auth errors
      if (error?.status === 401 || error?.status === 403) {
        return false;
      }
      return failureCount < 3;
    },
  });
  
  // Check if the error is an authentication issue
  const isAuthError = isError && (error as any)?.status === 401 || (error as any)?.status === 403;
  
  // Capture initial verified state on first contactData load
  useEffect(() => {
    if (contactData && initialVerifiedStateRef.current === null) {
      initialVerifiedStateRef.current = contactData.mobileVerified ?? false;
      console.log("[VerifyMobile] Initial mobileVerified state:", initialVerifiedStateRef.current);
    }
  }, [contactData]);
  
  // Auto-navigate when phone verification status CHANGES from false to true
  // This detects when user clicks the SMS verification link on their phone
  useEffect(() => {
    if (hasNavigatedRef.current || !contactData || initialVerifiedStateRef.current === null) {
      return;
    }
    
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

  useEffect(() => {
    if (contactData?.contacts?.mobile) {
      setMaskedMobile(contactData.contacts.mobile);
    }
  }, [contactData]);

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
        description: "Redirecting to code entry...",
      });
      navigate(`/student/${studentId}/verify-mobile-code`);
    },
    onError: (error: any) => {
      toast({
        title: "Failed to send code",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  // Calculate verification progress - MUST be before early returns
  const completedSteps = deriveVerificationProgress(student);
  // Current step is determined by the route
  const currentStep = getCurrentStepFromPath(location);
  const handleStepNavigate = useVerificationStepNavigation(studentId, currentStep, completedSteps);

  // Desktop heartbeat - send periodic updates so mobile knows PC is active
  useEffect(() => {
    if (isMobile || !studentId) return;
    
    const sendHeartbeat = async () => {
      try {
        await fetch(`/api/student/${studentId}/device-heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ device: 'desktop' }),
        });
      } catch (error) {
        console.error('[VerifyMobile] Heartbeat error:', error);
      }
    };
    
    // Send initial heartbeat immediately
    sendHeartbeat();
    
    // Then send every 30 seconds
    const interval = setInterval(sendHeartbeat, 30000);
    
    return () => clearInterval(interval);
  }, [isMobile, studentId]);

  // Send verification code to mobile number on file
  const handleSendCode = () => {
    sendCode.mutate();
  };

  // Handle continue to next step - check if PC is active first (only on mobile)
  const handleContinueToEmail = () => {
    if (isMobile && isPCSessionActive(student)) {
      setShowHandoffDialog(true);
    } else {
      navigate(`/student/${studentId}/verify-email`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

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
          <div className="space-y-6">
            <div className="text-center">
              {contactData?.mobileVerified ? (
                <div className="flex items-center justify-center gap-2 mb-1">
                  <CheckCircle2 className="h-6 w-6" style={{ color: '#355E3B' }} />
                  <p className="text-xl font-bold" style={{ color: '#355E3B', fontSize: '1.5rem' }}>
                    Step 4 Complete
                  </p>
                </div>
              ) : (
                <p className="text-xl font-bold mb-1" style={{ color: '#355E3B', fontSize: '1.5rem' }}>Step 4</p>
              )}
              <h1 className="text-2xl font-bold mb-2 flex items-center justify-center gap-2">
                <Phone className="h-6 w-6" />
                Verify Mobile Number
              </h1>
              {!contactData?.mobileVerified && (
                <p className="text-muted-foreground">
                  Confirm your mobile number to continue verification
                </p>
              )}
            </div>
        <Card>
        <CardContent className="pt-6">
          {maskedMobile ? (
            // Mobile number already on file
            <>
              {contactData?.mobileVerified ? (
                <>
                  <Alert className="mb-6 bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
                    <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <AlertDescription className="text-green-800 dark:text-green-200">
                      Your phone number <strong>{maskedMobile}</strong> has already been verified.
                    </AlertDescription>
                  </Alert>
                  
                  <div className="space-y-3">
                    <Button
                      onClick={handleContinueToEmail}
                      className="w-full"
                      data-testid="button-continue-email"
                    >
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Continue to Verify Email
                    </Button>
                    
                    <Button
                      onClick={handleSendCode}
                      variant="outline"
                      className="w-full"
                      disabled={sendCode.isPending}
                      data-testid="button-reverify-mobile"
                    >
                      {sendCode.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Sending Code...
                        </>
                      ) : (
                        <>
                          <Phone className="mr-2 h-4 w-4" />
                          Re-verify Phone Number
                        </>
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Alert className="mb-6">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      We will send a verification code to: <strong>{maskedMobile}</strong>
                    </AlertDescription>
                  </Alert>

                  <Button
                    onClick={handleSendCode}
                    className="w-full"
                    disabled={sendCode.isPending}
                    data-testid="button-send-mobile-code"
                  >
                    {sendCode.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Sending Code...
                      </>
                    ) : (
                      <>
                        <Phone className="mr-2 h-4 w-4" />
                        Send Verification Code
                      </>
                    )}
                  </Button>
                </>
              )}
            </>
          ) : isAuthError ? (
            // Authentication error - show login instructions
            <div className="space-y-4" data-testid="auth-error-container">
              <Alert variant="destructive">
                <Smartphone className="h-4 w-4" />
                <AlertDescription>
                  You need to be logged in to verify your mobile number.
                </AlertDescription>
              </Alert>
              
              <div className="text-center space-y-3 py-4">
                <Monitor className="h-12 w-12 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Please complete this step on your computer where you originally logged in, or log in again on this device.
                </p>
                <Button
                  onClick={() => navigate("/")}
                  variant="outline"
                  className="w-full"
                  data-testid="button-go-login"
                >
                  Go to Login
                </Button>
              </div>
            </div>
          ) : (
            // No mobile on file - show support message
            <Alert variant="destructive" data-testid="alert-no-mobile">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                No mobile number found on file. Please contact your school administrator for assistance.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
          </div>
        </div>
      </div>

      {/* Device Handoff Dialog - shown when mobile user tries to continue and PC is active */}
      <DeviceHandoffDialog
        open={showHandoffDialog}
        onOpenChange={setShowHandoffDialog}
        studentId={studentId}
        student={student}
        onContinueOnMobile={() => navigate(`/student/${studentId}/verify-email`)}
        onContinueOnPC={() => {
          navigate(`/student/${studentId}/handoff-complete?device=desktop`);
        }}
      />
    </div>
  );
}
