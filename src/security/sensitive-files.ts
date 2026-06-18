import * as path from "node:path";

function normalizeBasename(filePath: string): string {
  return path.basename(filePath).toLowerCase();
}

function isEnvSecretFile(base: string): boolean {
  if (base === ".env") return true;
  if (!base.startsWith(".env.")) return false;
  if (
    base === ".env.example" ||
    base === ".env.sample" ||
    base === ".env.template" ||
    base === ".env.schema"
  ) {
    return false;
  }
  return true;
}

export function getSensitiveFileReadReason(filePath: string): string | null {
  const base = normalizeBasename(filePath);
  if (isEnvSecretFile(base)) {
    return "environment secret files (.env*) are blocked by default";
  }

  if (base === ".npmrc" || base === ".pypirc" || base === ".netrc") {
    return `${base} may contain credentials`;
  }

  if (base === "credentials.json" || base === "application_default_credentials.json") {
    return `${base} commonly stores cloud credentials`;
  }

  if (base === "id_rsa" || base === "id_dsa" || base === "id_ecdsa" || base === "id_ed25519") {
    return `${base} is a private key file`;
  }

  if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12") ||
      base.endsWith(".pfx") || base.endsWith(".p8")) {
    return "certificate/private-key material is blocked by default";
  }

  return null;
}

export function isSensitiveFileForRead(filePath: string): boolean {
  return getSensitiveFileReadReason(filePath) !== null;
}
