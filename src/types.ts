export type EmailCategory = "URGENT" | "AUTH_CODE" | "NORMAL" | "JUNK";

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  category: EmailCategory;
  summary: string;
  isUrgent: boolean;
  verificationCode: string | null;
  verificationService: string | null;
  suggestedAction: string | null;
}

export interface UserProfile {
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}
