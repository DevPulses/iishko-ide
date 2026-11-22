// FILE: managedTerminalWrappers.ts
// Purpose: Create Superset-style managed command wrappers so terminal agent identity is canonical
// and survives zsh startup that rewrites PATH.

import fs from "node:fs";
import path from "node:path";

import {
  defaultTerminalTitleForCliKind,
  managedTerminalCommandNameForCliKind,
  IISHKO_TERMINAL_HOOK_OSC_PREFIX,
  IISHKO_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalAgentHookEventType,
  type ManagedTerminalCliKind,
} from "@iishko/shared/terminalThreads";

import { envPathKeyFor, resolveExecutable } from "../executableLookup.ts";
import {
  ensurePrivateDirectorySync,
  PRIVATE_EXECUTABLE_FILE_MODE,
  PRIVATE_FILE_MODE,
} from "../privatePathPermissions";

export interface ManagedTerminalWrapperState {
  binDir: string | null;
  codexHomeDir: string | null;
  hookScriptPath: string | null;
  claudeSettingsPath: string | null;
  zshDir: string | null;
  targetPathByCliKind: Partial<Record<ManagedTerminalCliKind, string>>;
}

export interface ManagedTerminalProfile {
  readonly instanceId?: string;
  readonly commandName: string;
  readonly targetPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly isolateEnvironment: boolean;
  readonly omittedSensitiveEnvironmentNames?: ReadonlyArray<string>;
}

const PROVIDER_PROFILE_MANIFEST_FILENAME = "provider-profiles.json";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function buildHookOscSequence(eventType: TerminalAgentHookEventType): string {
  return `\\033]${IISHKO_TERMINAL_HOOK_OSC_PREFIX}${eventType}\\007`;
}

function buildNotifyHookScript(): string {
  return `#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _iishko_hook_input="$1"
else
  _iishko_hook_input="$(cat)"
fi

_iishko_extract_event() {
  printf '%s' "$_iishko_hook_input" | sed -n "s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" | head -n 1
}

_iishko_event="$(_iishko_extract_event hook_event_name)"
if [ -z "$_iishko_event" ]; then
  _iishko_type="$(_iishko_extract_event type)"
  case "$_iishko_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _iishko_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _iishko_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _iishko_event="PermissionRequest"
      ;;
  esac
fi

_iishko_emit_osc() {
  _iishko_sequence="$1"
  if [ -w /dev/tty ]; then
    printf '%b' "$_iishko_sequence" > /dev/tty 2>/dev/null || printf '%b' "$_iishko_sequence"
    return
  fi
  printf '%b' "$_iishko_sequence"
}

case "$_iishko_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    _iishko_emit_osc '${buildHookOscSequence("Start")}'
    ;;
  Stop)
    _iishko_emit_osc '${buildHookOscSequence("Stop")}'
    ;;
  PermissionRequest|PreToolUse|Notification)
    _iishko_emit_osc '${buildHookOscSequence("PermissionRequest")}'
    ;;
esac
`;
}

function buildClaudeSettingsJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        Notification: [{ matcher: "*", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexHooksJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexWrapperScript(input: {
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { codexHomeDir, notifyHookPath, targetPath } = input;
  return [
    `export CODEX_HOME=${shellQuote(codexHomeDir)}`,
    `if [ -f ${shellQuote(notifyHookPath)} ]; then`,
    "  export CODEX_TUI_RECORD_SESSION=1",
    '  if [ -z "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then',
    '    _iishko_codex_ts="$(date +%s 2>/dev/null || echo "$$")"',
    '    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/iishko-codex-session-$$_${_iishko_codex_ts}.jsonl"',
    "  fi",
    "  (",
    '    _iishko_log="$CODEX_TUI_SESSION_LOG_PATH"',
    `    _iishko_notify=${shellQuote(notifyHookPath)}`,
    '    _iishko_last_turn_id=""',
    '    _iishko_last_approval_id=""',
    '    _iishko_last_exec_call_id=""',
    "    _iishko_approval_fallback_seq=0",
    "",
    "    _iishko_emit_event() {",
    '      _iishko_event="$1"',
    `      _iishko_payload=$(printf '{"hook_event_name":"%s"}' "$_iishko_event")`,
    '      "$_iishko_notify" "$_iishko_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    _iishko_i=0",
    '    while [ ! -f "$_iishko_log" ] && [ "$_iishko_i" -lt 200 ]; do',
    "      _iishko_i=$((_iishko_i + 1))",
    "      sleep 0.05",
    "    done",
    '    if [ ! -f "$_iishko_log" ]; then',
    "      exit 0",
    "    fi",
    "",
    '    tail -n 0 -F "$_iishko_log" 2>/dev/null | while IFS= read -r _iishko_line; do',
    '      case "$_iishko_line" in',
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)`,
    `          _iishko_turn_id=$(printf '%s\n' "$_iishko_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          [ -n "$_iishko_turn_id" ] || _iishko_turn_id="task_started"',
    '          if [ "$_iishko_turn_id" != "$_iishko_last_turn_id" ]; then',
    '            _iishko_last_turn_id="$_iishko_turn_id"',
    '            _iishko_emit_event "Start"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)`,
    `          _iishko_approval_id=$(printf '%s\n' "$_iishko_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_iishko_approval_id" ] || _iishko_approval_id=$(printf '%s\n' "$_iishko_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_iishko_approval_id" ] || _iishko_approval_id=$(printf '%s\n' "$_iishko_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -z "$_iishko_approval_id" ]; then',
    "            _iishko_approval_fallback_seq=$((_iishko_approval_fallback_seq + 1))",
    '            _iishko_approval_id="approval_request_${_iishko_approval_fallback_seq}"',
    "          fi",
    '          if [ "$_iishko_approval_id" != "$_iishko_last_approval_id" ]; then',
    '            _iishko_last_approval_id="$_iishko_approval_id"',
    '            _iishko_emit_event "PermissionRequest"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)`,
    `          _iishko_exec_call_id=$(printf '%s\n' "$_iishko_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -n "$_iishko_exec_call_id" ]; then',
    '            if [ "$_iishko_exec_call_id" != "$_iishko_last_exec_call_id" ]; then',
    '              _iishko_last_exec_call_id="$_iishko_exec_call_id"',
    '              _iishko_emit_event "Start"',
    "            fi",
    "          else",
    '            _iishko_emit_event "Start"',
    "          fi",
    "          ;;",
    "      esac",
    "    done",
    "  ) &",
    "  IISHKO_CODEX_START_WATCHER_PID=$!",
    "fi",
    `${shellQuote(targetPath)} --enable codex_hooks -c ${shellQuote(`notify=["bash",${JSON.stringify(notifyHookPath)}]`)} "$@"`,
    "_iishko_status=$?",
    'if [ -n "${IISHKO_CODEX_START_WATCHER_PID:-}" ]; then',
    '  kill "$IISHKO_CODEX_START_WATCHER_PID" >/dev/null 2>&1 || true',
    '  wait "$IISHKO_CODEX_START_WATCHER_PID" 2>/dev/null || true',
    "fi",
    'exit "$_iishko_status"',
  ].join("\n");
}

function buildWrapperScript(input: {
  claudeSettingsPath: string;
  cliKind: ManagedTerminalCliKind;
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { claudeSettingsPath, cliKind, codexHomeDir, notifyHookPath, targetPath } = input;
  const commandName = managedTerminalCommandNameForCliKind(cliKind);
  const title = defaultTerminalTitleForCliKind(cliKind);
  const commandBody =
    cliKind === "claude"
      ? `exec ${shellQuote(targetPath)} --settings ${shellQuote(claudeSettingsPath)} "$@"`
      : buildCodexWrapperScript({ codexHomeDir, notifyHookPath, targetPath });
  return [
    "#!/bin/sh",
    `# Managed ${commandName} wrapper injected by iishko terminal sessions.`,
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `export ${IISHKO_TERMINAL_CLI_KIND_ENV_KEY}=${shellQuote(cliKind)}`,
    commandBody,
    "",
  ].join("\n");
}

const PROFILE_INHERITED_ENV_KEYS = [
  "ALL_PROXY",
  "CURL_CA_BUNDLE",
  "COLORTERM",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "TEMP",
  "TMP",
  "FORCE_COLOR",
  "GIT_SSL_CAINFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "no_proxy",
  "PATH",
  "REQUESTS_CA_BUNDLE",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_RUNTIME_DIR",
] as const;

export function buildProviderProfileProcessEnv(
  profile: ManagedTerminalProfile,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inherited = profile.isolateEnvironment
    ? Object.fromEntries(
        Object.entries(baseEnv).filter(([key]) =>
          PROFILE_INHERITED_ENV_KEYS.some((allowed) => allowed.toUpperCase() === key.toUpperCase()),
        ),
      )
    : baseEnv;
  return { ...inherited, ...profile.environment };
}

export function buildProviderProfileWrapperScript(profile: ManagedTerminalProfile): string {
  const fixedEnvironment = Object.entries(profile.environment).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const environmentArguments = profile.isolateEnvironment
    ? [
        "exec env -i \\",
        ...PROFILE_INHERITED_ENV_KEYS.map((name) =>
          [`  ${name}=\"\${${name}:-}\" `, "\\"].join(""),
        ),
        ...fixedEnvironment.map(([name, value]) =>
          [`  ${name}=${shellQuote(value)} `, "\\"].join(""),
        ),
        `  ${shellQuote(profile.targetPath)} \"$@\"`,
      ]
    : [
        ...fixedEnvironment.map(([name, value]) => `export ${name}=${shellQuote(value)}`),
        `exec ${shellQuote(profile.targetPath)} \"$@\"`,
      ];
  return [
    "#!/bin/sh",
    `# IISHKO provider profile: ${profile.commandName}`,
    ...(profile.omittedSensitiveEnvironmentNames?.length
      ? [
          `# Sensitive environment is intentionally not serialized: ${profile.omittedSensitiveEnvironmentNames.join(
            ", ",
          )}`,
        ]
      : []),
    ...environmentArguments,
    "",
  ].join("\n");
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (currentContent !== content) {
    fs.writeFileSync(filePath, content, { mode });
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort.
  }
}

function readProviderProfileManifest(rootDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(rootDir, PROVIDER_PROFILE_MANIFEST_FILENAME), "utf8"),
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is string =>
            typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value),
        )
      : [];
  } catch {
    return [];
  }
}

function synchronizeProviderProfileWrappers(
  rootDir: string,
  profiles: ReadonlyArray<ManagedTerminalProfile>,
): void {
  const nextNames = new Set(profiles.map((profile) => profile.commandName));
  for (const previousName of readProviderProfileManifest(rootDir)) {
    if (nextNames.has(previousName)) continue;
    try {
      fs.unlinkSync(path.join(rootDir, previousName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const profile of profiles) {
    writeFileIfChanged(
      path.join(rootDir, profile.commandName),
      buildProviderProfileWrapperScript(profile),
      PRIVATE_EXECUTABLE_FILE_MODE,
    );
  }
  writeFileIfChanged(
    path.join(rootDir, PROVIDER_PROFILE_MANIFEST_FILENAME),
    `${JSON.stringify([...nextNames].toSorted(), null, 2)}\n`,
    PRIVATE_FILE_MODE,
  );
}

// Restore the user's parameter, including the unset state that makes zsh use HOME.
function restoreZshDotDir(variable: "IISHKO_ORIGINAL_ZDOTDIR" | "_iishko_user_zdotdir"): string {
  return `if [[ -v ${variable} ]]; then
  ZDOTDIR="\${${variable}}"
else
  unset ZDOTDIR
fi
`;
}

function sourceZshStartupFile(file: ".zshenv" | ".zprofile" | ".zshrc"): string {
  return `[[ -f "\${ZDOTDIR-$HOME}/${file}" ]] && source "\${ZDOTDIR-$HOME}/${file}"
`;
}

function buildManagedZshRc(): string {
  return `# IISHKO zsh rc wrapper
${restoreZshDotDir("_iishko_user_zdotdir")}unset _iishko_user_zdotdir
${sourceZshStartupFile(".zshrc")}if [ -n "\${IISHKO_MANAGED_BIN_DIR:-}" ] && [ -d "\${IISHKO_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:\${IISHKO_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="\${IISHKO_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "\${IISHKO_MANAGED_BIN_DIR}/claude" ] && [ ! -d "\${IISHKO_MANAGED_BIN_DIR}/claude" ]; then
      "\${IISHKO_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "\${IISHKO_MANAGED_BIN_DIR}/codex" ] && [ ! -d "\${IISHKO_MANAGED_BIN_DIR}/codex" ]; then
      "\${IISHKO_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _iishko_ensure_managed_bin() {
    case ":$PATH:" in
      *:\${IISHKO_MANAGED_BIN_DIR}:*) ;;
      *) PATH="\${IISHKO_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(\${precmd_functions:#_iishko_ensure_managed_bin} _iishko_ensure_managed_bin)
  } 2>/dev/null || true
fi
`;
}

function ensureManagedZshWrappers(zshDir: string): void {
  ensurePrivateDirectorySync(zshDir);
  // Only the interactive startup stages still need Iishko's wrapper directory.
  // Carry any change made by user code forward, and let zsh use it after .zshrc.
  const continueToManagedRc = `if [[ -o interactive && -o rcs ]]; then
  if [[ -v ZDOTDIR ]]; then
    _iishko_user_zdotdir="$ZDOTDIR"
  else
    unset _iishko_user_zdotdir
  fi
  ZDOTDIR=${shellQuote(zshDir)}
fi
`;
  writeFileIfChanged(
    path.join(zshDir, ".zshenv"),
    `# IISHKO zsh env wrapper
${restoreZshDotDir("IISHKO_ORIGINAL_ZDOTDIR")}unset IISHKO_ORIGINAL_ZDOTDIR
${sourceZshStartupFile(".zshenv")}${continueToManagedRc}`,
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zprofile"),
    `# IISHKO zsh profile wrapper
${restoreZshDotDir("_iishko_user_zdotdir")}${sourceZshStartupFile(".zprofile")}${continueToManagedRc}`,
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(path.join(zshDir, ".zshrc"), buildManagedZshRc(), PRIVATE_FILE_MODE);
}

export function prepareManagedTerminalWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  profiles?: ReadonlyArray<ManagedTerminalProfile>;
  rootDir: string;
  zshRootDir: string;
}): ManagedTerminalWrapperState {
  if (process.platform === "win32") {
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind: {},
    };
  }

  const targetPathByCliKind: Partial<Record<ManagedTerminalCliKind, string>> = {};
  for (const cliKind of ["codex", "claude"] as const) {
    const commandName = managedTerminalCommandNameForCliKind(cliKind);
    const targetPath = resolveExecutable(commandName, { env: options.baseEnv });
    if (!targetPath) {
      continue;
    }
    targetPathByCliKind[cliKind] = targetPath;
  }

  if (Object.keys(targetPathByCliKind).length === 0 && (options.profiles?.length ?? 0) === 0) {
    if (fs.existsSync(options.rootDir)) {
      synchronizeProviderProfileWrappers(options.rootDir, []);
    }
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind,
    };
  }

  ensurePrivateDirectorySync(options.rootDir);
  const codexHomeDir = path.join(options.rootDir, "codex-home");
  const hookScriptPath = path.join(options.rootDir, "notify-hook.sh");
  const claudeSettingsPath = path.join(options.rootDir, "claude-settings.json");
  ensurePrivateDirectorySync(codexHomeDir);
  writeFileIfChanged(hookScriptPath, buildNotifyHookScript(), PRIVATE_EXECUTABLE_FILE_MODE);
  writeFileIfChanged(
    claudeSettingsPath,
    buildClaudeSettingsJson(hookScriptPath),
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(codexHomeDir, "hooks.json"),
    buildCodexHooksJson(hookScriptPath),
    PRIVATE_FILE_MODE,
  );
  for (const [cliKind, targetPath] of Object.entries(targetPathByCliKind) as Array<
    [ManagedTerminalCliKind, string]
  >) {
    const wrapperPath = path.join(options.rootDir, managedTerminalCommandNameForCliKind(cliKind));
    writeFileIfChanged(
      wrapperPath,
      buildWrapperScript({
        claudeSettingsPath,
        cliKind,
        codexHomeDir,
        notifyHookPath: hookScriptPath,
        targetPath,
      }),
      PRIVATE_EXECUTABLE_FILE_MODE,
    );
  }
  synchronizeProviderProfileWrappers(options.rootDir, options.profiles ?? []);
  ensureManagedZshWrappers(options.zshRootDir);

  return {
    binDir: options.rootDir,
    codexHomeDir,
    hookScriptPath,
    claudeSettingsPath,
    zshDir: options.zshRootDir,
    targetPathByCliKind,
  };
}

function applyManagedTerminalWrapperEnvState(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  if (!wrapperState.binDir) {
    return env;
  }

  const envPathKey = envPathKeyFor(env);
  const currentPath = env[envPathKey]?.trim() ?? "";
  const currentEntries = currentPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!currentEntries.includes(wrapperState.binDir)) {
    currentEntries.unshift(wrapperState.binDir);
  }

  return {
    ...env,
    IISHKO_MANAGED_BIN_DIR: wrapperState.binDir,
    ...(env.ZDOTDIR !== undefined ? { IISHKO_ORIGINAL_ZDOTDIR: env.ZDOTDIR } : {}),
    ...(wrapperState.zshDir ? { ZDOTDIR: wrapperState.zshDir } : {}),
    [envPathKey]: currentEntries.join(path.delimiter),
  };
}

export function applyManagedTerminalAgentWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, wrapperState);
}

export function prepareManagedTerminalAgentWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  profiles?: ReadonlyArray<ManagedTerminalProfile>;
  targetDir: string;
  zshDir: string;
}): ManagedTerminalWrapperState {
  return prepareManagedTerminalWrappers({
    baseEnv: options.baseEnv,
    ...(options.profiles ? { profiles: options.profiles } : {}),
    rootDir: options.targetDir,
    zshRootDir: options.zshDir,
  });
}
