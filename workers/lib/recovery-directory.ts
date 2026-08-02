import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "./mail-address.ts";

export class RecoveryDirectoryError extends Error {
  readonly code: "UNMAPPED" | "INVALID_CONFIG";
  constructor(
    code: "UNMAPPED" | "INVALID_CONFIG" = "UNMAPPED",
    message = "Account recovery is not configured for this user",
  ) {
    super(message);
    this.name = "RecoveryDirectoryError";
    this.code = code;
  }
}

const RECOVERY_DIRECTORY_LIMITS = {
  bytes: 64 * 1024,
  entries: 1_024,
  addressBytes: 254,
} as const;

function boundedAddress(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= RECOVERY_DIRECTORY_LIMITS.addressBytes;
}

/**
 * Resolve the platform-operator managed recovery directory. The application
 * administrator never receives or modifies this secret.
 */
export function recoveryAddressFor(
  rawDirectory: string | undefined,
  portalEmail: string,
  configuredDomains: string | undefined,
): string {
  const normalizedPortal = normalizeMailAddress(portalEmail);
  if (!normalizedPortal || !boundedAddress(normalizedPortal)) {
    throw new RecoveryDirectoryError();
  }
  if (!rawDirectory) {
    throw new RecoveryDirectoryError(
      "INVALID_CONFIG",
      "Account recovery directory is invalid",
    );
  }
  if (new TextEncoder().encode(rawDirectory).byteLength > RECOVERY_DIRECTORY_LIMITS.bytes) {
    throw new RecoveryDirectoryError(
      "INVALID_CONFIG",
      "Account recovery directory is invalid",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDirectory);
  } catch {
    throw new RecoveryDirectoryError(
      "INVALID_CONFIG",
      "Account recovery directory is invalid",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RecoveryDirectoryError(
      "INVALID_CONFIG",
      "Account recovery directory is invalid",
    );
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > RECOVERY_DIRECTORY_LIMITS.entries) {
    throw new RecoveryDirectoryError(
      "INVALID_CONFIG",
      "Account recovery directory is invalid",
    );
  }
  const normalized = new Map<string, string>();
  for (const [portal, external] of entries) {
    const normalizedKey = portal === "*" ? portal : normalizeMailAddress(portal);
    const normalizedExternal =
      typeof external === "string" ? normalizeMailAddress(external) : null;
    if (
      !normalizedKey ||
      !normalizedExternal ||
      !boundedAddress(normalizedKey) ||
      !boundedAddress(normalizedExternal) ||
      isAddressInConfiguredMailDomains(normalizedExternal, configuredDomains) ||
      normalized.has(normalizedKey)
    ) {
      throw new RecoveryDirectoryError(
        "INVALID_CONFIG",
        "Account recovery directory is invalid",
      );
    }
    normalized.set(normalizedKey, normalizedExternal);
  }

  const address = normalized.get(normalizedPortal) ?? normalized.get("*");
  if (!address) throw new RecoveryDirectoryError();
  return address;
}

export function maskedRecoveryAddress(
  address: string | null | undefined,
): string {
  if (!address) return "Not configured";
  const [local, domain] = address.split("@");
  if (!local || !domain) return "Configured";
  const [domainName, ...suffixParts] = domain.split(".");
  const suffix = suffixParts.length ? `.${suffixParts.join(".")}` : "";
  return `${local.slice(0, 1)}•••@${domainName.slice(0, 1)}•••${suffix}`;
}
