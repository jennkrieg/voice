export interface CrmContact {
  externalId: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  fields: Record<string, unknown>;
}

/**
 * Canonical field names the platform understands. Anything else is passed to the CRM
 * as-is (HubSpot internal property name / GoHighLevel custom field key).
 */
export const CANONICAL_FIELDS = ["first_name", "last_name", "email", "phone"] as const;

export interface CrmProvider {
  kind: "hubspot" | "gohighlevel";
  getContact(externalId: string): Promise<CrmContact | null>;
  findByPhone(phoneE164: string): Promise<CrmContact | null>;
  createContact(input: { phone: string; firstName?: string; lastName?: string; email?: string }): Promise<CrmContact>;
  updateContact(externalId: string, fields: Record<string, string>): Promise<void>;
  addNote(externalId: string, body: string): Promise<void>;
}

export class CrmError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
  ) {
    super(`${provider} ${status}: ${message}`);
  }
}
