/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Mail,
  ShieldAlert,
  CheckCircle,
  RefreshCw,
  Search,
  LogOut,
  Inbox,
  AlertTriangle,
  Key,
  Sparkles,
  Filter,
  Plus,
  X,
  ChevronRight,
  Copy,
  Check,
  HelpCircle,
  Send,
  Eye,
  Settings,
  Brain,
  Phone,
  Trash2,
  Sliders,
  Bell,
  BellOff,
  MessageSquare,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { initAuth, googleSignIn, googleSignOut, getAccessToken } from "./firebase";
import { EmailMessage, EmailCategory } from "./types";
import { DEFAULT_SANDBOX_EMAILS } from "./sandboxData";

export default function App() {
  // Authentication state
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // App mode: real Gmail inbox vs interactive sandbox
  const [isSandbox, setIsSandbox] = useState(true);
  const [isFallbackActive, setIsFallbackActive] = useState(false);

  // Email storage
  const [emails, setEmails] = useState<EmailMessage[]>(DEFAULT_SANDBOX_EMAILS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI States
  const [activeTab, setActiveTab] = useState<EmailCategory | "ALL" | "IMPORTANT">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEmail, setSelectedEmail] = useState<EmailMessage | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [pollingRate, setPollingRate] = useState<number>(30); // in seconds
  const [timeSinceLastPoll, setTimeSinceLastPoll] = useState<number>(0);

  // AI Memory / Personalization Rules
  const [senderWeights, setSenderWeights] = useState<Record<string, "ALWAYS_URGENT" | "ALWAYS_JUNK" | "NORMAL">>(() => {
    const saved = localStorage.getItem("email_assistant_sender_weights");
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { console.error(e); }
    }
    return {
      "noreply@github.com": "ALWAYS_URGENT",
      "marketing@offers.megabrands.com": "ALWAYS_JUNK",
      "info@account.netflix.com": "ALWAYS_URGENT",
      "boss@company.com": "ALWAYS_URGENT",
    };
  });

  const [customKeywords, setCustomKeywords] = useState<Array<{ keyword: string; category: EmailCategory }>>(() => {
    const saved = localStorage.getItem("email_assistant_keywords");
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { console.error(e); }
    }
    return [
      { keyword: "kickoff", category: "URGENT" },
      { keyword: "server alert", category: "URGENT" },
      { keyword: "coupon", category: "JUNK" },
      { keyword: "otp", category: "AUTH_CODE" },
    ];
  });

  // Fast-Pass statistics returned from the backend (Two-Stage dashboard)
  const [fastPassCount, setFastPassCount] = useState<number>(0);
  const [aiCount, setAiCount] = useState<number>(0);

  // Right Segment Tab UI state: "BRAIN" (trained rules) | "INSPECTOR" (detail card) | "SMS_CONFIG" (phone simulator configuration)
  const [rightPanelTab, setRightPanelTab] = useState<"BRAIN" | "INSPECTOR" | "SMS_CONFIG">("BRAIN");

  // State for restoring recently archived emails
  const [archivedEmailBackup, setArchivedEmailBackup] = useState<{
    email: EmailMessage;
    index: number;
  } | null>(null);
  const [showUndoToast, setShowUndoToast] = useState(false);

  // OS Push Notification State
  const [pushEnabled, setPushEnabled] = useState<boolean>(() => {
    return localStorage.getItem("email_assistant_push_enabled") === "true";
  });

  // Phone Emulator state
  const [showMobileSimulator, setShowMobileSimulator] = useState<boolean>(true);
  const [simulatedSMS, setSimulatedSMS] = useState<{
    sender: string;
    body: string;
    time: string;
    visible: boolean;
  } | null>(null);

  // Form states for training and custom keywords rules
  const [newRuleEmail, setNewRuleEmail] = useState("");
  const [newRuleWeight, setNewRuleWeight] = useState<"ALWAYS_URGENT" | "ALWAYS_JUNK">("ALWAYS_URGENT");
  const [newKeywordText, setNewKeywordText] = useState("");
  const [newKeywordCategory, setNewKeywordCategory] = useState<EmailCategory>("URGENT");
  
  // Simulated SMS list on smartphone screen
  const [phoneSMSHistory, setPhoneSMSHistory] = useState<Array<{ sender: string; body: string; time: string }>>([
    {
      sender: "System Radar",
      body: "Virtual assistant security scanning system online. Send a simulated OTP code or urgent notice above to see immediate notification routing.",
      time: "10:00 AM",
    }
  ]);

  // Save brain states to localstorage
  useEffect(() => {
    localStorage.setItem("email_assistant_sender_weights", JSON.stringify(senderWeights));
  }, [senderWeights]);

  useEffect(() => {
    localStorage.setItem("email_assistant_keywords", JSON.stringify(customKeywords));
  }, [customKeywords]);

  // Auto-dismiss undo toast after 6 seconds
  useEffect(() => {
    if (showUndoToast) {
      const timer = setTimeout(() => {
        setShowUndoToast(false);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [showUndoToast, archivedEmailBackup]);

  // Sandbox Custom Email Creator Form
  const [showSandboxCreator, setShowSandboxCreator] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customSubject, setCustomSubject] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [isAnalyzingCustom, setIsAnalyzingCustom] = useState(false);

  // Custom UI notification when a new urgent email or OTP arrives
  const [inAppNotification, setInAppNotification] = useState<{
    title: string;
    body: string;
    type: "URGENT" | "AUTH_CODE";
  } | null>(null);

  // Ref for progress bar interval
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize Firebase Auth state listener
  useEffect(() => {
    const unsubscribe = initAuth(
      (firebaseUser, accessToken) => {
        setUser(firebaseUser);
        setToken(accessToken);
        setNeedsAuth(false);
        setIsSandbox(false); // Default to real inbox if authenticated
      },
      () => {
        setUser(null);
        setToken(null);
        setNeedsAuth(true);
        setIsSandbox(true); // Default to sandbox if not authenticated
      }
    );
    return () => unsubscribe();
  }, []);

  // Dispatch OS push notification if granted
  const triggerWebNotification = (title: string, body: string) => {
    if ("Notification" in window && Notification.permission === "granted" && pushEnabled) {
      try {
        new Notification(title, {
          body,
          tag: "email-assistant-otp",
        });
      } catch (err) {
        console.error("OS push dispatch failed:", err);
      }
    }
  };

  // Trigger simulated slide-down notification in the phone overlay
  const triggerSimulatedSMS = (sender: string, body: string) => {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setSimulatedSMS({
      sender,
      body,
      time,
      visible: true,
    });
    setPhoneSMSHistory((prev) => [
      { sender, body, time },
      ...prev,
    ]);
    // Autoclose phone notice after 8s
    setTimeout(() => {
      setSimulatedSMS((prev) => (prev ? { ...prev, visible: false } : null));
    }, 8000);
  };

  // Hit Twilio SMS backend endpoint
  const sendRealSMS = async (messageText: string) => {
    try {
      await fetch("/api/send-sms-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: messageText }),
      });
    } catch (e) {
      console.warn("Real SMS gateway dispatch failed:", e);
    }
  };

  // Master processing engine for incoming email alerts (compares old/new polling differences)
  const processNewEmailAlerts = async (newEmails: EmailMessage[], oldEmails: EmailMessage[]) => {
    if (oldEmails.length === 0) return; // Ignore cold startup scan

    const oldIds = new Set(oldEmails.map((e) => e.id));
    const brandNew = newEmails.filter((e) => !oldIds.has(e.id));

    for (const email of brandNew) {
      const isUrgent = email.category === "URGENT" || email.isUrgent;
      const isAuth = email.category === "AUTH_CODE" && email.verificationCode;

      if (isAuth) {
        // Display JUST the code for verification notices!
        const title = `🔑 ${email.verificationService || "OTP"} Code Extracted`;
        const body = `${email.verificationCode}`; // Display ONLY the code in body!

        // 1. Browser Push
        triggerWebNotification(title, body);

        // 2. Simulated iOS Banner
        const smsText = `Your ${email.verificationService} security verification code is: ${email.verificationCode}. Do not share this.`;
        triggerSimulatedSMS(email.verificationService || "Security Gate", smsText);

        // 3. Dispatch Twilio Server API request
        await sendRealSMS(smsText);

        // 4. In-App Toast
        triggerInAppNotification(
          `🔑 OTP Code Isolated!`,
          `Security Pin extracted: ${email.verificationCode}`,
          "AUTH_CODE"
        );
      } else if (isUrgent) {
        const cleanSender = email.from.split("<")[0].trim() || "Priority Sender";
        const title = `🚨 Priority Work Escalation`;
        const body = `From ${cleanSender}: "${email.subject}"`;

        // 1. Browser Push
        triggerWebNotification(title, body);

        // 2. Simulated iOS Banner
        const smsText = `🚨 Priority Escalation! From ${cleanSender}: "${email.subject}"`;
        triggerSimulatedSMS("Urgent Alert", smsText);

        // 3. Dispatch Twilio Server API request
        await sendRealSMS(smsText);

        // 4. In-App Toast
        triggerInAppNotification(
          `🚨 Urgent Email Flagged!`,
          `Summary: ${email.summary}`,
          "URGENT"
        );
      }
    }
  };

  // Train a sender address into custom memory rules
  const handleTrainSender = (senderEmail: string, weight: "ALWAYS_URGENT" | "ALWAYS_JUNK" | "NORMAL") => {
    const emailRegex = /<([^>]+)>/;
    const match = senderEmail.match(emailRegex);
    const cleanEmail = match ? match[1].trim() : senderEmail.trim();

    setSenderWeights((prev) => {
      const updated = { ...prev };
      if (weight === "NORMAL") {
        delete updated[cleanEmail.toLowerCase()];
      } else {
        updated[cleanEmail.toLowerCase()] = weight;
      }
      return updated;
    });

    triggerInAppNotification(
      `🧠 AI Trained Successfully`,
      `Emails from "${cleanEmail}" will now always resolve to ${weight.replace("ALWAYS_", "")}.`,
      "AUTH_CODE"
    );

    // Re-fetch email lists with updated weight rules immediately
    setTimeout(() => {
      fetchAndAnalyzeEmails(true);
    }, 150);
  };

  // Prompt the user for system browser notification credentials
  const handleRequestPushPermission = async () => {
    if (!("Notification" in window)) {
      alert("This browser does not support push notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setPushEnabled(true);
      localStorage.setItem("email_assistant_push_enabled", "true");
      new Notification("🔔 Notifications Enabled", {
        body: "AI Email Assistant is ready to push OTP codes and critical tasks.",
      });
    } else {
      setPushEnabled(false);
      localStorage.setItem("email_assistant_push_enabled", "false");
    }
  };

  // Fetch and analyze emails from backend
  const fetchAndAnalyzeEmails = useCallback(
    async (isManual = false) => {
      setIsLoading(true);
      setError(null);
      try {
        const currentToken = isSandbox ? null : token || getAccessToken();

        const response = await fetch("/api/analyze-emails", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken: currentToken,
            sandbox: isSandbox,
            sandboxEmails: emails, // Pass existing state for sandbox mutations
            userRules: {
              senderWeights,
              customKeywords,
            },
          }),
        });

        const rawText = await response.text();

        if (!response.ok) {
          let errMsg = "Failed to analyze emails.";
          try {
            const errData = JSON.parse(rawText);
            errMsg = errData.error || errMsg;
          } catch (e) {
            if (rawText) errMsg = rawText;
          }
          throw new Error(errMsg);
        }

        let data: any = null;
        try {
          data = JSON.parse(rawText);
        } catch (jsonErr) {
          console.warn("Response was not valid JSON, returning fallback structure.", jsonErr);
          data = { emails: [], isFallback: true };
        }

        const incomingEmails: EmailMessage[] = data?.emails || [];
        setIsFallbackActive(!!data?.isFallback);
        setFastPassCount(data?.fastPassCount || 0);
        setAiCount(data?.aiCount || 0);

        // Assess the inbox differences for smart notifications/alarms
        if (!isManual) {
          await processNewEmailAlerts(incomingEmails, emails);
        }

        setEmails(incomingEmails);
        setTimeSinceLastPoll(0);
      } catch (err: any) {
        console.error("Fetch Emails Error:", err);
        if (err.message === "Failed to fetch") {
          if (emails.length === 0) {
            setError("Connecting to email assistant server. This occurs while the server is initializing or restarting. Please wait a moment.");
          } else {
            console.warn("Transient connection/restart flicker encountered. Preserving current inbox data.");
          }
        } else {
          setError(err.message || "An error occurred while scanning your mailbox.");
        }
      } finally {
        setIsLoading(false);
      }
    },
    [isSandbox, token, emails, senderWeights, customKeywords]
  );

  // Trigger in-app transient banner notification
  const triggerInAppNotification = (title: string, body: string, type: "URGENT" | "AUTH_CODE") => {
    setInAppNotification({ title, body, type });
    setTimeout(() => {
      setInAppNotification(null);
    }, 6000);
  };

  // Run initial fetch when mode or token change
  useEffect(() => {
    fetchAndAnalyzeEmails(true);
  }, [isSandbox, token]);

  // Polling management for "Real-time" effect
  useEffect(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(() => {
      setTimeSinceLastPoll((prev) => {
        if (prev >= pollingRate - 1) {
          fetchAndAnalyzeEmails();
          return 0;
        }
        return prev + 1;
      });
    }, 1000);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [pollingRate, fetchAndAnalyzeEmails]);

  // Handle manual login
  const handleLogin = async () => {
    setIsLoggingIn(true);
    setError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setToken(result.accessToken);
        setUser(result.user);
        setNeedsAuth(false);
        setIsSandbox(false);
      }
    } catch (err: any) {
      console.error("Sign-in failed:", err);
      setError("Login failed or was cancelled by user.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Handle sign out
  const handleSignOut = async () => {
    try {
      await googleSignOut();
      setUser(null);
      setToken(null);
      setNeedsAuth(true);
      setIsSandbox(true);
      setEmails(DEFAULT_SANDBOX_EMAILS);
    } catch (err) {
      console.error("Sign-out failed:", err);
    }
  };

  // Copy code utility
  const handleCopyCode = (id: string, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  // Sandbox Custom Email Creation
  const handleCreateCustomEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customFrom || !customSubject || !customBody) return;

    setIsAnalyzingCustom(true);
    setError(null);

    try {
      const response = await fetch("/api/analyze-single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: customFrom,
          subject: customSubject,
          body: customBody,
          userRules: {
            senderWeights,
            customKeywords,
          },
        }),
      });

      const rawText = await response.text();

      if (!response.ok) {
        let errMsg = "Failed to analyze simulated email.";
        try {
          const errData = JSON.parse(rawText);
          errMsg = errData.error || errMsg;
        } catch (e) {
          if (rawText) errMsg = rawText;
        }
        throw new Error(errMsg);
      }

      let analyzedResult: any = null;
      try {
        analyzedResult = JSON.parse(rawText);
      } catch (jsonErr) {
        console.warn("Single response was not valid JSON, returning fallback.", jsonErr);
        analyzedResult = {
          category: "NORMAL",
          summary: customBody.substring(0, 100) + "...",
          isUrgent: false,
          verificationCode: null,
          verificationService: null,
          suggestedAction: "Review message details",
          isFallback: true,
        };
      }

      if (analyzedResult.isFallback) {
        setIsFallbackActive(true);
      }

      const newEmail: EmailMessage = {
        id: `sb-custom-${Date.now()}`,
        from: customFrom,
        subject: customSubject,
        date: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " (Just Now)",
        snippet: customBody.substring(0, 100) + "...",
        body: customBody,
        category: analyzedResult.category,
        summary: analyzedResult.summary,
        isUrgent: analyzedResult.isUrgent,
        verificationCode: analyzedResult.verificationCode || null,
        verificationService: analyzedResult.verificationService || null,
        suggestedAction: analyzedResult.suggestedAction || null,
      };

      // Add to front of sandbox email list
      const updatedList = [newEmail, ...emails];
      setEmails(updatedList);

      // Trigger alerts and notifications
      const isUrgent = newEmail.category === "URGENT" || newEmail.isUrgent;
      const isAuth = newEmail.category === "AUTH_CODE" && newEmail.verificationCode;

      if (isAuth) {
        const title = `🔑 Simulated OTP Extracted`;
        const body = `${newEmail.verificationCode}`; // Display ONLY the code in browser body!

        triggerWebNotification(title, body);

        const smsText = `Your simulated ${newEmail.verificationService} code is: ${newEmail.verificationCode}. Verified near-instantly.`;
        triggerSimulatedSMS(newEmail.verificationService || "Virtual Secure", smsText);
        await sendRealSMS(smsText);

        triggerInAppNotification(
          `🔑 Simulated Code Extracted!`,
          `${newEmail.verificationService || "Verification"} code is ${newEmail.verificationCode}`,
          "AUTH_CODE"
        );
      } else if (isUrgent) {
        const cleanSender = newEmail.from.split("<")[0].trim();
        const title = `🚨 Simulated Urgent Alert!`;
        const body = `From ${cleanSender}: "${newEmail.subject}"`;

        triggerWebNotification(title, body);

        const smsText = `🚨 Simulated Urgent: From ${cleanSender}: "${newEmail.subject}"`;
        triggerSimulatedSMS("Urgent Alert", smsText);
        await sendRealSMS(smsText);

        triggerInAppNotification(
          `🚨 Simulated Urgent Alert!`,
          `From ${newEmail.from}: "${newEmail.subject}"`,
          "URGENT"
        );
      }

      // Clear form
      setCustomFrom("");
      setCustomSubject("");
      setCustomBody("");
      setShowSandboxCreator(false);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to analyze simulated email.");
    } finally {
      setIsAnalyzingCustom(false);
    }
  };

  // Quick action solver (simulates marking code as copied, email resolved) with Undo support
  const handleResolveEmail = (emailId: string) => {
    const emailToArchive = emails.find((e) => e.id === emailId);
    if (emailToArchive) {
      const idx = emails.findIndex((e) => e.id === emailId);
      setArchivedEmailBackup({ email: emailToArchive, index: idx });
      setShowUndoToast(true);
    }

    setEmails((prev) => prev.filter((e) => e.id !== emailId));
    if (selectedEmail?.id === emailId) {
      setSelectedEmail(null);
    }
  };

  // Restore the recently archived email to its original position
  const handleUndoArchive = () => {
    if (!archivedEmailBackup) return;
    const { email, index: backupIdx } = archivedEmailBackup;
    setEmails((prev) => {
      if (prev.some((e) => e.id === email.id)) return prev;
      const updated = [...prev];
      // Make sure the index is within bounds before inserting
      const safeIndex = Math.min(Math.max(0, backupIdx), updated.length);
      updated.splice(safeIndex, 0, email);
      return updated;
    });
    setSelectedEmail(email);
    setRightPanelTab("INSPECTOR");
    setShowUndoToast(false);
    setArchivedEmailBackup(null);
  };

  // Filter calculation
  const urgentEmails = emails.filter((e) => e.category === "URGENT" || e.isUrgent);
  const authEmails = emails.filter((e) => e.category === "AUTH_CODE" && e.verificationCode);
  const normalEmails = emails.filter((e) => e.category === "NORMAL");
  const junkEmails = emails.filter((e) => e.category === "JUNK");

  const filteredEmails = emails.filter((email) => {
    // Search filter
    const matchesSearch =
      email.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
      email.from.toLowerCase().includes(searchQuery.toLowerCase()) ||
      email.summary.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    // Tab filter
    if (activeTab === "ALL") return true;
    if (activeTab === "IMPORTANT") return email.isUrgent || email.category === "URGENT";
    return email.category === activeTab;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col selection:bg-indigo-500/30 selection:text-indigo-200">
      
      {/* Dynamic Floating Banner Notification */}
      <AnimatePresence>
        {inAppNotification && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md p-4 rounded-xl shadow-2xl border flex items-start gap-3 backdrop-blur-md ${
              inAppNotification.type === "AUTH_CODE"
                ? "bg-emerald-950/90 border-emerald-500/50 text-emerald-100"
                : "bg-red-950/90 border-red-500/50 text-red-100"
            }`}
          >
            <div className={`p-2 rounded-lg ${inAppNotification.type === "AUTH_CODE" ? "bg-emerald-900/50" : "bg-red-900/50"}`}>
              {inAppNotification.type === "AUTH_CODE" ? (
                <Key className="w-5 h-5 text-emerald-400" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-red-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-sm tracking-tight">{inAppNotification.title}</h4>
              <p className="text-xs text-slate-300 mt-1">{inAppNotification.body}</p>
            </div>
            <button
              onClick={() => setInAppNotification(null)}
              className="text-slate-400 hover:text-slate-200 p-0.5 rounded-md"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Undo Toast Notification */}
      <AnimatePresence>
        {showUndoToast && archivedEmailBackup && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-6 right-6 z-50 max-w-sm w-full bg-slate-900/95 border border-indigo-500/30 shadow-2xl p-4 rounded-xl flex items-center justify-between gap-4 backdrop-blur-md"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 bg-indigo-950/45 border border-indigo-500/20 rounded-lg text-slate-300">
                <Trash2 className="w-4 h-4 text-indigo-400" />
              </div>
              <div className="min-w-0">
                <h5 className="text-xs font-semibold text-slate-200">Email Archived</h5>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">
                  "{archivedEmailBackup.email.subject}"
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleUndoArchive}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-all hover:scale-105 active:scale-95 shadow-lg shadow-indigo-600/15"
              >
                Undo
              </button>
              <button
                onClick={() => setShowUndoToast(false)}
                className="p-1 hover:bg-slate-800 rounded-md text-slate-500 hover:text-slate-300 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Header / Navigation Area */}
      <header className="border-b border-slate-800/80 bg-slate-900/50 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg border border-indigo-500/20 shadow-inner">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display font-bold text-lg tracking-tight bg-gradient-to-r from-indigo-300 via-indigo-200 to-indigo-400 bg-clip-text text-transparent flex items-center gap-2">
                AI Email Assistant
                {isFallbackActive && (
                  <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full font-mono font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>
                    Local Safe Guard Active
                  </span>
                )}
              </h1>
              <p className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping"></span>
                ACTIVE MONITORING SYSTEM
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Mode Switcher */}
            <div className="bg-slate-950 p-1 rounded-lg border border-slate-800 flex items-center gap-1">
              <button
                onClick={() => {
                  setIsSandbox(true);
                  setError(null);
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                  isSandbox
                    ? "bg-slate-800 text-amber-400 border border-slate-700/50 shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>Sandbox Mode</span>
              </button>
              <button
                disabled={needsAuth}
                onClick={() => {
                  setIsSandbox(false);
                  setError(null);
                }}
                title={needsAuth ? "Sign in to activate real Gmail monitoring" : ""}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 disabled:opacity-45 ${
                  !isSandbox
                    ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                <span>Real Inbox</span>
              </button>
            </div>

            {/* Auth Button or Profile Info */}
            {needsAuth ? (
              <button
                onClick={handleLogin}
                disabled={isLoggingIn}
                className="gsi-material-button scale-95 origin-right"
              >
                <div className="gsi-material-button-content-wrapper">
                  <div className="gsi-material-button-icon">
                    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: "block" }}>
                      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                    </svg>
                  </div>
                  <span className="gsi-material-button-contents text-xs font-semibold text-slate-800">
                    {isLoggingIn ? "Signing in..." : "Link Gmail"}
                  </span>
                </div>
              </button>
            ) : (
              <div className="flex items-center gap-2">
                {user?.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || "User"}
                    referrerPolicy="no-referrer"
                    className="w-7 h-7 rounded-full border border-indigo-500/40"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs text-indigo-400 font-bold">
                    {user?.email?.charAt(0).toUpperCase() || "A"}
                  </div>
                )}
                <button
                  onClick={handleSignOut}
                  className="p-1.5 bg-slate-900 border border-slate-800 text-slate-400 hover:text-red-400 hover:bg-red-950/20 rounded-lg transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 flex flex-col gap-5">
        
        {/* API Warning/Error message */}
        {error && (
          <div className="bg-red-950/60 border border-red-500/40 p-4 rounded-xl text-red-200 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <span className="font-semibold block">Mail Assistant Error:</span>
              <p className="mt-0.5 text-slate-300">{error}</p>
              {error.includes("GEMINI_API_KEY") && (
                <div className="mt-2 text-xs text-slate-400 font-mono">
                  Tip: Make sure the <code className="bg-slate-900 px-1 py-0.5 rounded text-red-300">GEMINI_API_KEY</code> variable is set up properly in your Secrets panel (Settings &gt; Secrets).
                </div>
              )}
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Informative Header Callout */}
        {isSandbox && (
          <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/20 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
            <div className="flex gap-2.5 items-start">
              <div className="p-1.5 bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/10 shrink-0 mt-0.5 sm:mt-0">
                <HelpCircle className="w-4.5 h-4.5" />
              </div>
              <div>
                <span className="text-xs font-semibold text-amber-300 tracking-tight block sm:inline mr-1.5">
                  Sandbox Active:
                </span>
                <span className="text-xs text-slate-300">
                  You are evaluating preloaded emails. Link your Gmail to process your real-time inbox automatically!
                </span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setShowSandboxCreator(true)}
                className="px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-medium rounded-lg transition-colors flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Simulate New Email
              </button>
              {needsAuth && (
                <button
                  onClick={handleLogin}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg shadow-md hover:shadow-indigo-500/10 transition-all flex items-center gap-1"
                >
                  <Mail className="w-3.5 h-3.5" />
                  Connect Gmail
                </button>
              )}
            </div>
          </div>
        )}

        {/* 1. TOP BENTO GRID: Urgent Passcodes & High Priority Warnings */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          
          {/* Quick OTC Panel (Authentication Codes) - 2 columns on medium up */}
          <div className="md:col-span-2 bg-slate-900/45 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between shadow-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 w-48 h-48 bg-emerald-500/5 blur-[80px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between gap-4 border-b border-slate-800/60 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-emerald-500/15 text-emerald-400 rounded-lg border border-emerald-500/10">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-sm">Passcode Quick-Extract</h3>
                  <p className="text-[10px] text-slate-400">Security verification codes automatically detected</p>
                </div>
              </div>
              <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full font-mono">
                SECURE SANDBOX
              </span>
            </div>

            {authEmails.length === 0 ? (
              <div className="py-8 flex flex-col items-center justify-center text-center">
                <div className="p-3 bg-slate-950 rounded-full text-slate-600 border border-slate-800/50 mb-2">
                  <Inbox className="w-6 h-6" />
                </div>
                <p className="text-xs text-slate-400 font-medium">No login codes detected in recent emails</p>
                <p className="text-[10px] text-slate-500 max-w-xs mt-1">
                  Once an authentication or MFA email lands, the AI extracts and isolates the code here immediately.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {authEmails.slice(0, 4).map((email) => (
                  <div
                    key={email.id}
                    className="p-3.5 bg-slate-950/60 border border-slate-800 hover:border-emerald-500/25 rounded-xl flex flex-col justify-between transition-all animate-auth-glow"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-200">
                        {email.verificationService || "Verification PIN"}
                      </span>
                      <span className="text-[9px] text-slate-500 font-mono">{email.date.split(",")[2] || "Just now"}</span>
                    </div>
                    
                    <div className="my-3 flex items-center justify-between gap-3 bg-emerald-950/20 border border-emerald-500/15 rounded-lg px-3 py-2">
                      <span className="font-mono text-xl font-bold tracking-widest text-emerald-400 select-all">
                        {email.verificationCode}
                      </span>
                      <button
                        onClick={() => handleCopyCode(email.id, email.verificationCode || "")}
                        className="p-1 text-slate-400 hover:text-emerald-400 bg-slate-900 border border-slate-800 hover:border-emerald-500/30 rounded transition-all"
                        title="Copy to Clipboard"
                      >
                        {copiedCodeId === email.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400 animate-bounce" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2 mt-1">
                      <span className="text-[10px] text-slate-400 truncate max-w-[130px]">{email.suggestedAction}</span>
                      <button
                        onClick={() => handleResolveEmail(email.id)}
                        className="text-[9px] font-semibold text-indigo-400 hover:text-indigo-300"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Real-time Assistant Radar Box */}
          <div className="bg-slate-900/45 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between shadow-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 blur-[60px] rounded-full pointer-events-none" />
            
            <div>
              <div className="flex items-center justify-between gap-4 border-b border-slate-800/60 pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-indigo-500/15 text-indigo-400 rounded-lg border border-indigo-500/10">
                    <RefreshCw className="w-4 h-4 animate-spin-slow" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-sm">Virtual Radar</h3>
                    <p className="text-[10px] text-slate-400">Scanning frequency dashboard</p>
                  </div>
                </div>
              </div>

              <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 mb-4 text-center">
                <span className="text-2xl font-bold font-mono tracking-tight text-indigo-300">
                  {pollingRate - timeSinceLastPoll}
                  <span className="text-xs text-slate-500 font-normal">s</span>
                </span>
                <p className="text-[10px] text-slate-400 mt-1 font-mono uppercase tracking-wider">
                  Until Automated Inbox Check
                </p>
                <div className="w-full bg-slate-900 rounded-full h-1 mt-2.5 overflow-hidden border border-slate-800">
                  <div
                    className="bg-indigo-500 h-full transition-all duration-1000 ease-linear rounded-full"
                    style={{ width: `${(timeSinceLastPoll / pollingRate) * 100}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs border-b border-slate-800/40 pb-1.5">
                <span className="text-slate-400">Total Analyzed:</span>
                <span className="font-mono font-medium text-slate-200">{emails.length} emails</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs border-b border-slate-800/40 pb-1.5">
                <span className="text-slate-400">Urgent Threshold:</span>
                <span className="font-medium text-red-400 flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" />
                  Auto-Escalate
                </span>
              </div>
              <button
                disabled={isLoading}
                onClick={() => fetchAndAnalyzeEmails(true)}
                className="w-full mt-2 py-1.5 bg-indigo-600/10 hover:bg-indigo-600/25 border border-indigo-500/25 text-indigo-300 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                {isLoading ? "Scanning..." : "Check Inbox Now"}
              </button>
            </div>
          </div>
        </div>

        {/* 2. SUBMIT CUSTOM SIMULATOR DRAWER (COLLAPSIBLE) */}
        <AnimatePresence>
          {showSandboxCreator && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <form
                onSubmit={handleCreateCustomEmail}
                className="bg-slate-900/60 border border-slate-800 p-5 rounded-2xl flex flex-col gap-4 shadow-inner"
              >
                <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                    <h3 className="font-display font-semibold text-sm text-amber-300">
                      Simulate Incoming Email Context
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSandboxCreator(false)}
                    className="p-1 hover:bg-slate-800 rounded-md text-slate-400 hover:text-slate-200"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-slate-400 font-medium">Sender name & address</label>
                    <input
                      required
                      type="text"
                      placeholder='e.g., Apple Security <noreply@apple.com>'
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="bg-slate-950 border border-slate-800 hover:border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none rounded-xl px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 transition-colors"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-slate-400 font-medium">Subject line</label>
                    <input
                      required
                      type="text"
                      placeholder='e.g., Important Security Pin'
                      value={customSubject}
                      onChange={(e) => setCustomSubject(e.target.value)}
                      className="bg-slate-950 border border-slate-800 hover:border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none rounded-xl px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 transition-colors"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-400 font-medium">Email content body</label>
                  <textarea
                    required
                    rows={4}
                    placeholder="Enter the full simulated email text body... Include OTPs or critical notices to test the extraction engine."
                    value={customBody}
                    onChange={(e) => setCustomBody(e.target.value)}
                    className="bg-slate-950 border border-slate-800 hover:border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none rounded-xl p-3 text-xs text-slate-100 placeholder:text-slate-600 transition-colors font-mono"
                  />
                </div>

                <div className="flex justify-end gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      // Preset templates
                      setCustomFrom("Delta Air Lines <delta.delta@delta.com>");
                      setCustomSubject("URGENT: Flight DL-482 Gate Change & Delayed");
                      setCustomBody("Dear Passenger,\n\nYour flight DL-482 today has been rescheduled. It will depart 45 minutes later than planned, and the departure gate has been changed to Gate B22. Please report to the gate immediately.");
                    }}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-semibold rounded-lg transition-colors"
                  >
                    Load Gate Change Example
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomFrom("Instagram Security <security@mail.instagram.com>");
                      setCustomSubject("Instagram verification code code: IG-95123");
                      setCustomBody("Hi user,\n\nUse code IG-95123 to verify your device login session on Chrome. If this wasn't you, ignore.");
                    }}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-semibold rounded-lg transition-colors"
                  >
                    Load OTP Example
                  </button>
                  <button
                    type="submit"
                    disabled={isAnalyzingCustom}
                    className="px-4 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-xs font-semibold rounded-lg shadow-md hover:shadow-indigo-500/20 transition-all flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {isAnalyzingCustom ? "AI Analyzing..." : "Send to Virtual Assistant"}
                  </button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 3. PRIMARY GRID: Email filter and detailed explorer view */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          
          {/* Email List Left Segment - 3 columns */}
          <div className="lg:col-span-3 flex flex-col gap-4">
            
            {/* Search and Filters panel */}
            <div className="bg-slate-900/40 p-4 rounded-2xl border border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-3.5 shadow-sm">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search emails, AI summaries..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 hover:border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none rounded-xl pl-10 pr-4 py-2 text-xs text-slate-100 placeholder:text-slate-500 transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Polling selection */}
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-slate-400 font-mono">POLL TIME:</span>
                <select
                  value={pollingRate}
                  onChange={(e) => {
                    setPollingRate(Number(e.target.value));
                    setTimeSinceLastPoll(0);
                  }}
                  className="bg-slate-950 border border-slate-800 text-slate-300 text-xs font-semibold rounded-lg px-2.5 py-1.5 focus:border-indigo-500 outline-none"
                >
                  <option value={15}>15s (Turbo)</option>
                  <option value={30}>30s (Default)</option>
                  <option value={60}>60s</option>
                  <option value={180}>3m</option>
                </select>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: "Inbox", id: "ALL", icon: Inbox },
                { label: "Important", id: "IMPORTANT", icon: ShieldAlert, color: "text-red-400" },
                { label: "Passcodes", id: "AUTH_CODE", icon: Key, color: "text-emerald-400" },
                { label: "Normal", id: "NORMAL", icon: Mail, color: "text-blue-400" },
                { label: "Junk Filtered", id: "JUNK", icon: TrashIcon, color: "text-slate-400" },
              ].map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                
                // Get badge count
                let count = emails.length;
                if (tab.id === "IMPORTANT") count = urgentEmails.length;
                else if (tab.id === "AUTH_CODE") count = authEmails.length;
                else if (tab.id === "NORMAL") count = normalEmails.length;
                else if (tab.id === "JUNK") count = junkEmails.length;

                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-xl flex items-center gap-2 transition-all border ${
                      isActive
                        ? "bg-indigo-600 border-indigo-500 text-white shadow-md shadow-indigo-600/15"
                        : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Icon className={`w-3.5 h-3.5 ${tab.color || ""}`} />
                    <span>{tab.label}</span>
                    <span
                      className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded-full ${
                        isActive ? "bg-indigo-700 text-indigo-100" : "bg-slate-950 text-slate-500 border border-slate-800/80"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Emails List Container */}
            <div className="space-y-2.5 max-h-[600px] overflow-y-auto pr-1">
              {isLoading && emails.length === 0 ? (
                <div className="py-20 flex flex-col items-center justify-center text-center">
                  <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mb-3" />
                  <p className="text-sm font-medium">Scanning your inbox...</p>
                  <p className="text-xs text-slate-400 max-w-xs mt-1">
                    Analyzing sender priority, summarizing headers and classifying messages with Gemini.
                  </p>
                </div>
              ) : filteredEmails.length === 0 ? (
                <div className="py-16 text-center border border-slate-800 bg-slate-900/20 rounded-2xl">
                  <Mail className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-xs font-medium text-slate-400">No emails fit this filter</p>
                  <p className="text-[10px] text-slate-500 max-w-xs mx-auto mt-1">
                    Try modifying your search or click "Simulate New Email" to add simulated emails!
                  </p>
                </div>
              ) : (
                filteredEmails.map((email) => {
                  const isSelected = selectedEmail?.id === email.id;
                  const isUrgent = email.category === "URGENT" || email.isUrgent;
                  const isAuth = email.category === "AUTH_CODE";
                  
                  return (
                    <div
                      key={email.id}
                      onClick={() => {
                        setSelectedEmail(email);
                        setRightPanelTab("INSPECTOR");
                      }}
                      className={`group p-4 rounded-xl border transition-all cursor-pointer text-left relative overflow-hidden ${
                        isSelected
                          ? "bg-indigo-950/20 border-indigo-500/50"
                          : isUrgent
                          ? "bg-red-950/10 hover:bg-red-950/15 border-red-500/10 hover:border-red-500/30 animate-urgent-glow"
                          : isAuth
                          ? "bg-emerald-950/10 hover:bg-emerald-950/15 border-emerald-500/10 hover:border-emerald-500/30"
                          : "bg-slate-900/40 hover:bg-slate-900/60 border-slate-800 hover:border-slate-700"
                      }`}
                    >
                      {/* Priority left edge band */}
                      <div
                        className={`absolute left-0 top-0 bottom-0 w-1 ${
                          isUrgent ? "bg-red-500" : isAuth ? "bg-emerald-500" : "bg-slate-800"
                        }`}
                      />

                      <div className="flex items-start justify-between gap-3 ml-1">
                        <div className="min-w-0 flex-1">
                          {/* Sender and Date */}
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="font-display font-semibold text-xs tracking-tight text-indigo-300 truncate group-hover:text-indigo-200">
                              {email.from.split("<")[0].trim() || email.from}
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono shrink-0">
                              {email.date.split(",")[2]?.trim() || email.date}
                            </span>
                          </div>

                          {/* Subject */}
                          <h4 className="font-semibold text-xs text-slate-200 mb-1.5 truncate">
                            {email.subject}
                          </h4>

                          {/* AI Assistant Executive Summary */}
                          <div className="bg-slate-950/55 rounded-lg border border-slate-800 p-2.5 my-2 flex items-start gap-2">
                            <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5 animate-pulse" />
                            <div className="text-xs">
                              <span className="font-semibold text-[10px] text-indigo-300 uppercase tracking-wider block mb-0.5">
                                Virtual Assistant Summary
                              </span>
                              <p className="text-slate-300 text-[11px] leading-relaxed italic">
                                "{email.summary}"
                              </p>
                            </div>
                          </div>

                          {/* Quick Badges / Actions Row */}
                          <div className="flex items-center justify-between gap-2 mt-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {/* Category Badge */}
                              <span
                                className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                                  isUrgent
                                    ? "bg-red-500/15 text-red-400 border border-red-500/20"
                                    : isAuth
                                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                    : "bg-indigo-500/15 text-indigo-400 border border-indigo-500/20"
                                }`}
                              >
                                {email.category}
                              </span>

                              {/* Target Action Help */}
                              {email.suggestedAction && (
                                <span className="text-[9px] font-mono text-slate-500">
                                  ↳ {email.suggestedAction}
                                </span>
                              )}
                            </div>

                            {/* Verification Quick Action */}
                            {isAuth && email.verificationCode && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyCode(email.id, email.verificationCode || "");
                                }}
                                className="px-2 py-0.8 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400 rounded text-[10px] font-semibold transition-colors flex items-center gap-1"
                              >
                                {copiedCodeId === email.id ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                <span>Copy Code</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Chevron right indicator */}
                        <ChevronRight className="w-4 h-4 text-slate-600 self-center group-hover:text-slate-400 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Interactive Right Column Segment (Trained Rules, Message Inspector, Virtual Smartphone Simulator) */}
          <div className="lg:col-span-2">
            {/* Right Panel Tab bar */}
            <div className="bg-slate-900/60 p-1 rounded-xl border border-slate-800/80 mb-4 flex items-center justify-between gap-1 shadow-sm">
              <button
                onClick={() => setRightPanelTab("BRAIN")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                  rightPanelTab === "BRAIN"
                    ? "bg-slate-800 text-indigo-300 border border-slate-700/50 shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Brain className="w-3.5 h-3.5" />
                <span>AI Memory</span>
              </button>
              <button
                onClick={() => setRightPanelTab("INSPECTOR")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 relative ${
                  rightPanelTab === "INSPECTOR"
                    ? "bg-slate-800 text-indigo-300 border border-slate-700/50 shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Inspector</span>
                {selectedEmail && (
                  <span className="absolute top-1.5 right-2 w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping"></span>
                )}
              </button>
              <button
                onClick={() => setRightPanelTab("SMS_CONFIG")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                  rightPanelTab === "SMS_CONFIG"
                    ? "bg-slate-800 text-indigo-300 border border-slate-700/50 shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Phone className="w-3.5 h-3.5" />
                <span>Phone Demo</span>
              </button>
            </div>

            <AnimatePresence mode="wait">
              {/* TAB 1: AI BRAIN RULES */}
              {rightPanelTab === "BRAIN" && (
                <motion.div
                  key="brain-tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="space-y-4"
                >
                  {/* Two-Stage Routing Telemetry stats card */}
                  <div className="bg-slate-900/45 border border-slate-800 p-4 rounded-xl shadow-lg">
                    <h4 className="text-xs font-semibold text-slate-300 mb-2.5 flex items-center gap-1.5">
                      <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                      Two-Stage Routing Telemetry
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-slate-950/60 border border-slate-800/60 p-3 rounded-lg">
                        <span className="text-[9px] text-emerald-400 font-mono font-bold block uppercase tracking-wider">Fast Pass Hits</span>
                        <span className="text-xl font-bold font-mono text-slate-100">{fastPassCount}</span>
                        <p className="text-[9px] text-slate-500 mt-1 leading-relaxed">Classified instantly by local rules (zero latency & cost)</p>
                      </div>
                      <div className="bg-slate-950/60 border border-slate-800/60 p-3 rounded-lg">
                        <span className="text-[9px] text-indigo-400 font-mono font-bold block uppercase tracking-wider">Gemini Pass Hits</span>
                        <span className="text-xl font-bold font-mono text-slate-100">{aiCount}</span>
                        <p className="text-[9px] text-slate-500 mt-1 leading-relaxed">Processed using full-scale server intelligence</p>
                      </div>
                    </div>
                  </div>

                  {/* Trained Senders panel */}
                  <div className="bg-slate-900/45 border border-slate-800 rounded-xl p-4 shadow-lg">
                    <h4 className="text-xs font-semibold text-slate-200 mb-3 flex items-center gap-1.5">
                      <Brain className="w-3.5 h-3.5 text-indigo-400" />
                      Trained Senders Memory ({Object.keys(senderWeights).length})
                    </h4>
                    
                    {/* Add Trained Rule form */}
                    <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800 mb-3 flex flex-col gap-2">
                      <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-wider">Train Sender Address</span>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="email"
                          placeholder="e.g. boss@company.com"
                          value={newRuleEmail}
                          onChange={(e) => setNewRuleEmail(e.target.value)}
                          className="flex-1 bg-slate-950 border border-slate-800 text-xs px-2.5 py-1.5 rounded-md outline-none focus:border-indigo-500 text-slate-100 placeholder:text-slate-600"
                        />
                        <select
                          value={newRuleWeight}
                          onChange={(e) => setNewRuleWeight(e.target.value as any)}
                          className="bg-slate-950 border border-slate-800 text-xs px-2 py-1.5 rounded-md text-slate-300 font-semibold focus:border-indigo-500 outline-none"
                        >
                          <option value="ALWAYS_URGENT">Always Urgent</option>
                          <option value="ALWAYS_JUNK">Always Junk</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            if (!newRuleEmail.trim()) return;
                            handleTrainSender(newRuleEmail.trim(), newRuleWeight);
                            setNewRuleEmail("");
                          }}
                          className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
                        >
                          Train
                        </button>
                      </div>
                    </div>

                    {/* Active Trained list */}
                    <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                      {Object.keys(senderWeights).length === 0 ? (
                        <p className="text-[10px] text-slate-500 text-center py-2">No custom trained senders yet.</p>
                      ) : (
                        Object.entries(senderWeights).map(([email, weight]) => (
                          <div key={email} className="flex items-center justify-between gap-2 p-2 bg-slate-950/40 rounded-md border border-slate-800/40">
                            <span className="text-xs text-slate-300 font-mono truncate">{email}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                                weight === "ALWAYS_URGENT" ? "bg-red-500/10 text-red-400 border border-red-500/20" : "bg-slate-500/10 text-slate-400 border border-slate-500/20"
                              }`}>
                                {weight === "ALWAYS_URGENT" ? "Urgent" : "Junk"}
                              </span>
                              <button
                                onClick={() => handleTrainSender(email, "NORMAL")}
                                className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                                title="Delete Rule"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Custom Keyword Triggers panel */}
                  <div className="bg-slate-900/45 border border-slate-800 rounded-xl p-4 shadow-lg">
                    <h4 className="text-xs font-semibold text-slate-200 mb-3 flex items-center gap-1.5">
                      <Filter className="w-3.5 h-3.5 text-indigo-400" />
                      Custom Keyword Triggers ({customKeywords.length})
                    </h4>

                    {/* Add Keyword form */}
                    <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800 mb-3 flex flex-col gap-2">
                      <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-wider">Add Keyword Rule</span>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          placeholder="e.g. coupon, otp, alarm"
                          value={newKeywordText}
                          onChange={(e) => setNewKeywordText(e.target.value)}
                          className="flex-1 bg-slate-950 border border-slate-800 text-xs px-2.5 py-1.5 rounded-md outline-none focus:border-indigo-500 text-slate-100 placeholder:text-slate-600"
                        />
                        <select
                          value={newKeywordCategory}
                          onChange={(e) => setNewKeywordCategory(e.target.value as any)}
                          className="bg-slate-950 border border-slate-800 text-xs px-2 py-1.5 rounded-md text-slate-300 font-semibold focus:border-indigo-500 outline-none"
                        >
                          <option value="URGENT">Urgent</option>
                          <option value="AUTH_CODE">Passcodes</option>
                          <option value="NORMAL">Normal</option>
                          <option value="JUNK">Junk</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            if (!newKeywordText.trim()) return;
                            const kw = newKeywordText.trim().toLowerCase();
                            if (customKeywords.some((item) => item.keyword === kw)) {
                              alert("Keyword rule already exists!");
                              return;
                            }
                            setCustomKeywords((prev) => [...prev, { keyword: kw, category: newKeywordCategory }]);
                            setNewKeywordText("");
                            triggerInAppNotification("🧠 Rule Saved", `Added trigger keyword "${kw}"`, "AUTH_CODE");
                            setTimeout(() => fetchAndAnalyzeEmails(true), 150);
                          }}
                          className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
                        >
                          Add Rule
                        </button>
                      </div>
                    </div>

                    {/* Active Keyword list */}
                    <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                      {customKeywords.length === 0 ? (
                        <p className="text-[10px] text-slate-500 text-center py-2">No custom keywords configured.</p>
                      ) : (
                        customKeywords.map(({ keyword, category }) => (
                          <div key={keyword} className="flex items-center justify-between gap-2 p-2 bg-slate-950/40 rounded-md border border-slate-800/40">
                            <span className="text-xs text-indigo-300 font-mono font-semibold">"{keyword}"</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                                category === "URGENT" ? "bg-red-500/10 text-red-400 border border-red-500/20" :
                                category === "AUTH_CODE" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                                category === "JUNK" ? "bg-slate-500/10 text-slate-400 border border-slate-500/20" :
                                "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                              }`}>
                                {category.replace("_", " ")}
                              </span>
                              <button
                                onClick={() => {
                                  setCustomKeywords((prev) => prev.filter((item) => item.keyword !== keyword));
                                  triggerInAppNotification("🧠 Rule Deleted", `Removed trigger keyword "${keyword}"`, "AUTH_CODE");
                                  setTimeout(() => fetchAndAnalyzeEmails(true), 150);
                                }}
                                className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                                title="Delete Rule"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* TAB 2: DEEP EMAIL DETAILS INSPECTOR */}
              {rightPanelTab === "INSPECTOR" && (
                <motion.div
                  key="inspector-tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="min-h-[480px]"
                >
                  {selectedEmail ? (
                    <div className="bg-slate-900/50 border border-indigo-500/20 rounded-2xl p-5 shadow-xl flex flex-col justify-between h-full">
                      <div>
                        {/* Header Controls */}
                        <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-3 mb-4">
                          <div className="flex items-center gap-1.5">
                            <Sparkles className="w-4.5 h-4.5 text-indigo-400" />
                            <h3 className="font-display font-semibold text-sm">Deep AI Assessment</h3>
                          </div>
                          <button
                            onClick={() => setSelectedEmail(null)}
                            className="p-1 hover:bg-slate-800 rounded-md text-slate-400 hover:text-slate-200"
                            title="Close Explorer"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Sender & Meta details */}
                        <div className="space-y-1.5 mb-4">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">From Sender</span>
                            <span className="text-[10px] text-slate-500 font-mono">{selectedEmail.date}</span>
                          </div>
                          <p className="font-display font-semibold text-xs text-indigo-300 break-all select-all">
                            {selectedEmail.from}
                          </p>
                          
                          <div className="pt-2">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">Subject</span>
                            <p className="font-semibold text-sm text-slate-100">{selectedEmail.subject}</p>
                          </div>
                        </div>

                        {/* AI Assessment Verdict */}
                        <div className="bg-indigo-950/15 border border-indigo-500/20 p-4 rounded-xl space-y-3 mb-4 relative">
                          <div className="absolute top-0 right-0 p-2 text-indigo-500">
                            <Sparkles className="w-4 h-4" />
                          </div>
                          
                          <div>
                            <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-wider block mb-0.5">
                              Virtual Assistant Verdict
                            </span>
                            <p className="text-slate-300 text-xs italic leading-relaxed">
                              "{selectedEmail.summary}"
                            </p>
                          </div>

                          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-indigo-500/10">
                            <div>
                              <span className="text-[9px] font-medium text-slate-400 uppercase tracking-wider block">
                                Assessed Urgency
                              </span>
                              <span
                                className={`text-xs font-semibold ${
                                  selectedEmail.isUrgent || selectedEmail.category === "URGENT"
                                    ? "text-red-400"
                                    : "text-slate-400"
                                }`}
                              >
                                {selectedEmail.isUrgent || selectedEmail.category === "URGENT" ? "🚨 Highly Urgent" : "Normal priority"}
                              </span>
                            </div>
                            <div>
                              <span className="text-[9px] font-medium text-slate-400 uppercase tracking-wider block">
                                Classification
                              </span>
                              <span className="text-xs font-semibold text-slate-200 capitalize">
                                {selectedEmail.category.toLowerCase().replace("_", " ")}
                              </span>
                            </div>
                          </div>

                          {selectedEmail.verificationCode && (
                            <div className="pt-2.5 border-t border-indigo-500/10">
                              <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider block mb-1">
                                Extracted Verification Code
                              </span>
                              <div className="bg-emerald-950/30 border border-emerald-500/20 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
                                <span className="font-mono text-lg font-bold text-emerald-400 tracking-wider">
                                  {selectedEmail.verificationCode}
                                </span>
                                <button
                                  onClick={() => handleCopyCode(selectedEmail.id, selectedEmail.verificationCode || "")}
                                  className="px-2.5 py-1 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/20 text-emerald-300 rounded text-xs font-semibold transition-all flex items-center gap-1"
                                >
                                  {copiedCodeId === selectedEmail.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                  <span>{copiedCodeId === selectedEmail.id ? "Copied" : "Copy"}</span>
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Email Source Body content */}
                        <div className="pt-1 mb-4">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">Original Email Body</span>
                            <span className="text-[9px] text-slate-500 font-mono">ID: {selectedEmail.id}</span>
                          </div>
                          <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-xl max-h-[160px] overflow-y-auto">
                            <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap leading-relaxed select-text">
                              {selectedEmail.body}
                            </pre>
                          </div>
                        </div>

                        {/* Live Memory Training Actions inside Inspector */}
                        <div className="p-3 bg-slate-950/60 border border-slate-800/85 rounded-xl">
                          <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider block mb-2">🧠 Smart AI Memory Tuning</span>
                          <p className="text-[10px] text-slate-400 mb-3">Instruct the assistant on how to prioritize future emails from this sender.</p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => handleTrainSender(selectedEmail.from, "ALWAYS_URGENT")}
                              className="flex-1 py-1 px-2.5 bg-red-950/30 hover:bg-red-950/50 border border-red-500/20 text-red-300 rounded-lg text-xs font-semibold transition-all"
                            >
                              Always Urgent
                            </button>
                            <button
                              onClick={() => handleTrainSender(selectedEmail.from, "ALWAYS_JUNK")}
                              className="flex-1 py-1 px-2.5 bg-slate-800/50 hover:bg-slate-800/80 border border-slate-700/50 text-slate-300 rounded-lg text-xs font-semibold transition-all"
                            >
                              Always Junk
                            </button>
                            <button
                              onClick={() => handleTrainSender(selectedEmail.from, "NORMAL")}
                              className="py-1 px-2.5 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-400 hover:text-slate-200 rounded-lg text-xs transition-all"
                            >
                              Reset
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Actions Bar Footer */}
                      <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-800/80 mt-4 bg-slate-900/10">
                        <button
                          onClick={() => handleResolveEmail(selectedEmail.id)}
                          className="px-4 py-1.5 bg-red-950/25 hover:bg-red-950/45 border border-red-950/50 hover:border-red-500/30 text-red-400 rounded-xl text-xs font-semibold transition-colors"
                        >
                          Archive & Dismiss
                        </button>
                        {selectedEmail.suggestedAction && (
                          <span className="text-[10px] text-slate-500 font-mono italic">
                            Suggested: {selectedEmail.suggestedAction}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-slate-900/25 border border-dashed border-slate-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center min-h-[480px]">
                      <div className="p-4 bg-slate-900/60 rounded-full border border-slate-800 mb-4">
                        <Eye className="w-8 h-8 text-slate-600" />
                      </div>
                      <h3 className="font-display font-semibold text-sm mb-1.5 text-slate-300">
                        Email Inspector Idle
                      </h3>
                      <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                        Select an email or security passcode from your inbox to view full original body, headers, and AI reasoning.
                      </p>
                    </div>
                  )}
                </motion.div>
              )}

              {/* TAB 3: PHONE EMULATOR & NOTIFICATIONS CONFIGURATION */}
              {rightPanelTab === "SMS_CONFIG" && (
                <motion.div
                  key="sms-tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="space-y-4"
                >
                  {/* Delivery channels */}
                  <div className="bg-slate-900/45 border border-slate-800 rounded-xl p-4 shadow-lg">
                    <h4 className="text-xs font-semibold text-slate-200 mb-3 flex items-center gap-1.5">
                      <Bell className="w-3.5 h-3.5 text-indigo-400" />
                      Real-Time Delivery Channels
                    </h4>
                    
                    <div className="space-y-3">
                      {/* OS Push Notification control */}
                      <div className="flex items-center justify-between gap-3 p-3 bg-slate-950/40 rounded-lg border border-slate-800/40">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                            OS Browser Push Alerts
                            {pushEnabled ? (
                              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                            ) : (
                              <span className="w-1.5 h-1.5 bg-amber-500 rounded-full"></span>
                            )}
                          </span>
                          <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">Pushes authentication codes directly to your native desktop alerts.</p>
                        </div>
                        <button
                          onClick={handleRequestPushPermission}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all border shrink-0 ${
                            pushEnabled
                              ? "bg-emerald-950/20 hover:bg-emerald-950/30 border-emerald-500/30 text-emerald-300"
                              : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm"
                          }`}
                        >
                          {pushEnabled ? "Enabled" : "Enable"}
                        </button>
                      </div>

                      {/* Twilio Status */}
                      <div className="p-3 bg-slate-950/40 rounded-lg border border-slate-800/40 flex items-center justify-between gap-3">
                        <div>
                          <span className="text-xs font-semibold text-slate-100">
                            Twilio SMS Gateway Bridge
                          </span>
                          <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">Runs in secure backend. Intercepts alerts and automatically triggers real text alerts if configured.</p>
                        </div>
                        <span className="text-[9px] bg-slate-900 text-slate-400 border border-slate-800 px-2 py-0.5 rounded-full font-mono shrink-0">
                          AUTO-BRIDGE
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Visual CSS Smartphone Device emulator */}
                  <div className="bg-slate-900/45 border border-slate-800 rounded-2xl p-4 shadow-lg flex flex-col items-center">
                    <div className="w-full flex items-center justify-between mb-3.5">
                      <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <Phone className="w-3.5 h-3.5 text-indigo-400" />
                        Live Smartphone Emulator
                      </span>
                      <button
                        onClick={() => setShowMobileSimulator(!showMobileSimulator)}
                        className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold"
                      >
                        {showMobileSimulator ? "Hide Emulator" : "Show Emulator"}
                      </button>
                    </div>

                    {showMobileSimulator && (
                      <div className="relative w-[280px] h-[480px] bg-slate-950 rounded-[40px] border-[8px] border-slate-800 shadow-2xl overflow-hidden flex flex-col justify-between">
                        {/* Interactive Slide down iOS SMS Banner notice */}
                        <AnimatePresence>
                          {simulatedSMS && simulatedSMS.visible && (
                            <motion.div
                              initial={{ y: -100, opacity: 0 }}
                              animate={{ y: 8, opacity: 1 }}
                              exit={{ y: -100, opacity: 0 }}
                              transition={{ type: "spring", stiffness: 120, damping: 15 }}
                              onClick={() => setRightPanelTab("INSPECTOR")}
                              className="absolute left-2.5 right-2.5 z-50 bg-slate-900/95 border border-slate-700/60 backdrop-blur shadow-2xl p-2.5 rounded-2xl cursor-pointer hover:border-slate-500 transition-colors"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[9px] font-bold text-indigo-400 flex items-center gap-1">
                                  <MessageSquare className="w-2.5 h-2.5" />
                                  MESSAGES
                                </span>
                                <span className="text-[8px] text-slate-500 font-mono">now</span>
                              </div>
                              <p className="text-[10px] font-semibold text-slate-200 line-clamp-1">{simulatedSMS.sender}</p>
                              <p className="text-[9px] text-slate-300 line-clamp-2 mt-0.5">{simulatedSMS.body}</p>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        {/* Top Speaker Notch bar */}
                        <div className="h-6 bg-slate-950/80 backdrop-blur-md absolute top-0 left-0 right-0 z-30 px-5 flex items-center justify-between text-[8px] font-semibold text-slate-400 font-mono select-none">
                          <span>9:41 AM</span>
                          <div className="w-16 h-3.5 bg-slate-950 rounded-full absolute left-1/2 -translate-x-1/2 top-0 flex items-center justify-center">
                            <div className="w-2.5 h-1 bg-slate-900 rounded-full"></div>
                          </div>
                          <div className="flex items-center gap-1">
                            <span>5G</span>
                            <span className="w-2.5 h-1.5 bg-indigo-500 rounded-sm"></span>
                          </div>
                        </div>

                        {/* Screen Simulator Panel with dynamic notification inbox */}
                        <div className="flex-1 bg-gradient-to-b from-indigo-950/40 via-slate-950 to-slate-950 pt-8 pb-3 px-3 flex flex-col justify-between overflow-hidden relative">
                          {/* Wallpaper accent */}
                          <div className="absolute top-1/4 left-1/4 w-24 h-24 bg-indigo-500/10 blur-[40px] rounded-full pointer-events-none" />

                          {/* Message header */}
                          <div className="border-b border-slate-800/80 pb-1.5 mb-2 z-10">
                            <h5 className="text-[10px] font-bold text-slate-300 tracking-tight flex items-center gap-1 uppercase">
                              <MessageSquare className="w-2.5 h-2.5 text-indigo-400" />
                              SMS Alert Log history
                            </h5>
                          </div>

                          {/* Log lists */}
                          <div className="flex-1 overflow-y-auto space-y-1.5 pr-0.5 scrollbar-none z-10">
                            {phoneSMSHistory.length === 0 ? (
                              <div className="h-full flex items-center justify-center text-center p-4">
                                <p className="text-[9px] text-slate-600">SMS history is empty.</p>
                              </div>
                            ) : (
                              phoneSMSHistory.map((sms, i) => (
                                <div key={i} className="bg-slate-900/80 border border-slate-800/50 rounded-xl p-2 shadow-sm">
                                  <div className="flex items-center justify-between gap-1 mb-0.5">
                                    <span className="text-[8px] font-bold text-slate-200 truncate">{sms.sender}</span>
                                    <span className="text-[7px] text-slate-500 font-mono">{sms.time}</span>
                                  </div>
                                  <p className="text-[8px] text-slate-400 leading-relaxed font-mono whitespace-pre-wrap">{sms.body}</p>
                                </div>
                              ))
                            )}
                          </div>

                          {/* iOS swipe gesture home bar */}
                          <div className="mt-1.5 text-center select-none z-10">
                            <div className="w-16 h-1 bg-slate-700/80 mx-auto rounded-full"></div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>

      </main>

      {/* Footer System Status details */}
      <footer className="border-t border-slate-900/80 bg-slate-950 p-4 mt-auto">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <p className="font-mono">
            © 2026 AI Email Assistant. {isFallbackActive ? "Local Rules Analyzer Active (Gemini offline)" : "Running with Google Gemini 3.5."}
          </p>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 font-mono text-[10px]">
              <span className="inline-block w-2 h-2 bg-indigo-500 rounded-full animate-pulse"></span>
              SECURE TLS PROXY ACTIVE
            </span>
            <span className="text-slate-700">|</span>
            <a href="#privacy" className="hover:text-slate-400 transition-colors">Privacy Policy</a>
          </div>
        </div>
      </footer>

    </div>
  );
}

// Simple fallback icon to avoid breaking build in React-18/19
function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}
