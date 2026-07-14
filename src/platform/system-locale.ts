import { execFileSync } from "node:child_process";

type LocaleReader = (file: string, args: readonly string[]) => string;

let localeResolved = false;
let cachedLocale: string | undefined;

export function getSystemLocale(): string | undefined {
  if (!localeResolved) {
    cachedLocale = resolveSystemLocale(process.platform, readLocaleCommand)
      ?? Intl.DateTimeFormat().resolvedOptions().locale;
    localeResolved = true;
  }
  return cachedLocale;
}

export function resolveSystemLocale(
  platform: NodeJS.Platform,
  read: LocaleReader,
): string | undefined {
  try {
    if (platform === "darwin") {
      return canonicalLocale(read("/usr/bin/defaults", ["read", "-g", "AppleLocale"]));
    }
    if (platform === "win32") {
      const output = read("reg.exe", [
        "query",
        "HKCU\\Control Panel\\International",
        "/v",
        "LocaleName",
      ]);
      const locale = /LocaleName\s+REG_SZ\s+([^\s]+)/u.exec(output)?.[1];
      return locale === undefined ? undefined : canonicalLocale(locale);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function canonicalLocale(raw: string): string | undefined {
  const locale = raw.trim().replace(/^"|"$/gu, "").split("@", 1)[0]?.replaceAll("_", "-");
  if (locale === undefined || locale.length === 0) return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(locale)[0];
    if (canonical === undefined) return undefined;
    const requested = new Intl.Locale(canonical);
    const resolved = new Intl.Locale(new Intl.DateTimeFormat(canonical).resolvedOptions().locale);
    if (requested.region !== undefined && resolved.region !== requested.region) {
      const regional = new Intl.Locale(`und-${requested.region}`).maximize();
      return Intl.getCanonicalLocales(`${regional.language}-${requested.region}`)[0];
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function readLocaleCommand(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 4_096,
    timeout: 1_000,
    windowsHide: true,
  });
}
