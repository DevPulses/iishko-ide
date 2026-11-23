// FILE: wsIishkoAccountRpc.ts
// Purpose: The IISHKO gateway account RPC handlers, as one owner-guarded unit.
// Layer: server RPC handlers
//
// The gateway key is owner state: a paired client-role session must neither
// read nor replace it. The guard runs before each handler effect is built, and
// errors keep only a message and code, never a cause derived from a request
// that carried the key.

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WS_METHODS, WsRpcError } from "@iishko/contracts";
import { Effect, Schema } from "effect";

import { unwrapTryPromiseError } from "./accountRpcErrors";
import type { IishkoAccount } from "./iishkoAccount";
import { iishkoHomeDir } from "./iishkoSession";
import { discoverPiSubagents, iishkoAgentsDir } from "./provider/piSubagents";
import { requireOwnerRole } from "./wsOwnerOnly";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const CYRILLIC_SLUG: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function toIishkoWsRpcError(rawCause: unknown, fallbackMessage: string): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  return Schema.is(WsRpcError)(cause) ? cause : new WsRpcError({ message: fallbackMessage });
}

const ownerIishkoRpc = <A>(make: () => Promise<A>, fallbackMessage: string) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      Effect.tryPromise(make).pipe(
        Effect.mapError((cause) => toIishkoWsRpcError(cause, fallbackMessage)),
      ),
    ),
  );

export function makeIishkoAccountRpcHandlers(account: IishkoAccount) {
  return {
    [WS_METHODS.iishkoAccountStatus]: () =>
      ownerIishkoRpc(() => account.status(), "Failed to read the IISHKO account"),
    [WS_METHODS.iishkoBeginTelegramPairing]: () =>
      ownerIishkoRpc(() => account.beginTelegramPairing(), "Failed to start Telegram sign-in"),
    [WS_METHODS.iishkoPollTelegramPairing]: (input: { readonly pairingId: string }) =>
      ownerIishkoRpc(() => account.pollTelegramPairing(input), "Failed to check Telegram sign-in"),
    [WS_METHODS.iishkoCancelTelegramPairing]: (input: { readonly pairingId: string }) =>
      ownerIishkoRpc(() => account.cancelTelegramPairing(input), "Failed to cancel sign-in"),
    [WS_METHODS.iishkoConnectApiKey]: (input: { readonly apiKey: string }) =>
      ownerIishkoRpc(() => account.connectApiKey(input), "Failed to connect the API key"),
    [WS_METHODS.iishkoProfile]: () =>
      ownerIishkoRpc(() => account.profile(), "Failed to load the IISHKO profile"),
    [WS_METHODS.iishkoSubagentsList]: (input: { readonly cwd?: string | undefined }) =>
      ownerIishkoRpc(async () => {
        const home = iishkoHomeDir();
        const cwd = input.cwd?.trim() || home;
        const agents = await discoverPiSubagents({ agentsHomeDir: home, cwd });
        return {
          agents: agents.map((agent) => {
            const entry: {
              name: string;
              description: string;
              source: (typeof agent)["source"];
              path?: string;
              model?: string;
              tools?: string[];
            } = {
              name: agent.name,
              description: agent.description,
              source: agent.source,
            };
            if (agent.source !== "builtin") entry.path = agent.filePath;
            if (agent.model) entry.model = agent.model;
            if (agent.tools) entry.tools = [...agent.tools];
            return entry;
          }),
          directories: {
            home: iishkoAgentsDir(home),
            project: join(cwd, ".iishko", "agents"),
          },
        };
      }, "Failed to list IISHKO subagents"),
    [WS_METHODS.iishkoSubagentsCreate]: (input: { readonly name: string }) =>
      ownerIishkoRpc(async () => {
        const home = iishkoHomeDir();
        const agentsDir = iishkoAgentsDir(home);
        await mkdir(agentsDir, { recursive: true });
        // The name lands in YAML frontmatter and a markdown heading: strip line
        // breaks so it cannot inject fields, and transliterate Cyrillic so the
        // file slug stays ASCII.
        const displayName = input.name.replace(/[\r\n]+/g, " ").trim();
        const transliterated = displayName
          .toLowerCase()
          .split("")
          .map((ch) => CYRILLIC_SLUG[ch] ?? ch)
          .join("");
        const slug =
          transliterated
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "agent";
        let filePath = join(agentsDir, `${slug}.md`);
        for (let i = 2; await pathExists(filePath); i += 1) {
          filePath = join(agentsDir, `${slug}-${i}.md`);
        }
        await writeFile(
          filePath,
          `---\nname: ${slug}\ndescription: ${displayName}\n---\n\n# ${displayName}\n\nDescribe what this subagent should do.\n`,
          "utf-8",
        );
        return { path: filePath };
      }, "Failed to create the IISHKO subagent file"),
    [WS_METHODS.iishkoSignOut]: () =>
      ownerIishkoRpc(() => account.signOut(), "Failed to disconnect the IISHKO account"),
  };
}
