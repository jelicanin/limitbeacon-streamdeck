import { posix, win32 } from "node:path";

export type LocatorFileStat = {
  isFile(): boolean;
  mode: number;
};

export type LocatorDependencies = {
  platform: "darwin" | "win32";
  arch: "x64" | "arm64";
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
  stat(path: string): Promise<LocatorFileStat>;
  execFile(file: string, args: readonly string[]): Promise<{ stdout: string }>;
};

export class CodexLocatorError extends Error {
  readonly code = "CODEX_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodexLocatorError";
  }
}

export async function locateCodex(
  override: string,
  deps: LocatorDependencies,
): Promise<string> {
  const path = deps.platform === "win32" ? win32 : posix;

  if (override !== "") {
    if (!path.isAbsolute(override)) {
      throw new CodexLocatorError("Configured Codex executable path must be absolute");
    }
    const candidate = path.normalize(override);
    if (await isExecutableFile(candidate, deps)) {
      return candidate;
    }
    throw new CodexLocatorError("Configured Codex executable was not found or is not executable");
  }

  const candidates =
    deps.platform === "win32"
      ? await windowsCandidates(deps)
      : macCandidates(deps);
  const seen = new Set<string>();

  for (const rawCandidate of candidates) {
    if (!path.isAbsolute(rawCandidate)) {
      continue;
    }
    const candidate = path.normalize(rawCandidate);
    const identity = deps.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    if (await isExecutableFile(candidate, deps)) {
      return candidate;
    }
  }

  throw new CodexLocatorError("Codex CLI executable was not found");
}

async function isExecutableFile(
  candidate: string,
  deps: LocatorDependencies,
): Promise<boolean> {
  if (deps.platform === "win32" && win32.extname(candidate).toLowerCase() !== ".exe") {
    return false;
  }

  try {
    const stat = await deps.stat(candidate);
    if (!stat.isFile()) {
      return false;
    }
    return deps.platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function macCandidates(deps: LocatorDependencies): string[] {
  const candidates: string[] = [];
  for (const directory of deps.env.PATH?.split(":") ?? []) {
    if (posix.isAbsolute(directory)) {
      candidates.push(posix.join(directory, "codex"));
    }
  }

  const installDirectory = deps.env.CODEX_INSTALL_DIR;
  if (installDirectory && posix.isAbsolute(installDirectory)) {
    candidates.push(posix.join(installDirectory, "codex"));
  }

  candidates.push(
    posix.join(deps.homeDirectory, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  );
  return candidates;
}

async function windowsCandidates(deps: LocatorDependencies): Promise<string[]> {
  const candidates: string[] = [];
  const systemRoot = deps.env.SystemRoot ?? deps.env.SYSTEMROOT;
  if (systemRoot && win32.isAbsolute(systemRoot)) {
    const where = win32.join(systemRoot, "System32", "where.exe");
    try {
      const result = await deps.execFile(where, ["codex"]);
      candidates.push(
        ...result.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
    } catch {
      // Automatic discovery continues with documented install locations.
    }
  }

  const installDirectory = deps.env.CODEX_INSTALL_DIR;
  if (installDirectory && win32.isAbsolute(installDirectory)) {
    candidates.push(win32.join(installDirectory, "codex.exe"));
  }

  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData && win32.isAbsolute(localAppData)) {
    candidates.push(
      win32.join(
        localAppData,
        "Programs",
        "OpenAI",
        "Codex",
        "bin",
        "codex.exe",
      ),
    );
  }

  const appData = deps.env.APPDATA;
  if (appData && win32.isAbsolute(appData)) {
    candidates.push(...windowsNpmCandidates(appData, deps.arch));
  }

  return candidates;
}

function windowsNpmCandidates(appData: string, arch: LocatorDependencies["arch"]): string[] {
  const packageName = `codex-win32-${arch}`;
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const packageRoots = [
    win32.join(
      appData,
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      packageName,
    ),
    win32.join(appData, "npm", "node_modules", "@openai", packageName),
  ];

  return packageRoots.flatMap((root) => [
    win32.join(root, "vendor", target, "bin", "codex.exe"),
    win32.join(root, "vendor", target, "codex", "codex.exe"),
  ]);
}
