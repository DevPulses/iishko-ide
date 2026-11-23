// FILE: IishkoSubagentsSection.tsx
// Purpose: Lists discovered IISHKO (Pi) subagents and creates a user agent template.
// Layer: Web IISHKO account feature (settings section).

import type { IishkoSubagentsList } from "@iishko/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

const SOURCE_LABEL_KEYS = {
  builtin: "settings:iishkoSubagents_builtin",
  user: "settings:iishkoSubagents_user",
  project: "settings:iishkoSubagents_project",
} as const;

function AgentRow({ agent }: { agent: IishkoSubagentsList["agents"][number] }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-ui-sm font-medium">{agent.name}</p>
        <p className="truncate text-ui-sm text-muted-foreground">{agent.description}</p>
        {agent.path ? (
          <p className="truncate font-mono text-ui-xs text-muted-foreground/70">{agent.path}</p>
        ) : null}
      </div>
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-ui-xs text-muted-foreground">
        {t(SOURCE_LABEL_KEYS[agent.source])}
      </span>
    </li>
  );
}

export function IishkoSubagentsSection({ className }: { className?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["iishko-subagents", "projects"],
    queryFn: () => ensureNativeApi().orchestration.getShellSnapshot(),
    staleTime: 60_000,
  });
  const cwd = projectsQuery.data?.projects[0]?.workspaceRoot;
  const agentsQuery = useQuery({
    queryKey: ["iishko-subagents", "list", cwd ?? null],
    queryFn: () => ensureNativeApi().iishko.subagentsList(cwd ? { cwd } : {}),
    enabled: projectsQuery.isSuccess,
  });

  const openFolder = async () => {
    const directories = agentsQuery.data?.directories;
    if (!directories?.home) return;
    setBusy(true);
    setError(null);
    try {
      await ensureNativeApi().shell.showInFolder(directories.home);
    } catch {
      setError(t("settings:iishkoAccount_network"));
    } finally {
      setBusy(false);
    }
  };

  const createAgent = async () => {
    const name = agentName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ensureNativeApi().iishko.subagentsCreate({ name });
      setAgentName("");
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ["iishko-subagents", "list"] });
      await ensureNativeApi().shell.showInFolder(result.path);
    } catch {
      setError(t("settings:iishkoAccount_network"));
    } finally {
      setBusy(false);
    }
  };

  const agents = agentsQuery.data?.agents ?? [];

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-5 text-card-foreground",
        className,
      )}
      data-testid="iishko-subagents-section"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-ui-lg font-medium">{t("settings:iishkoSubagents_title")}</h3>
          <p className="text-ui-sm text-muted-foreground">{t("settings:iishkoSubagents_intro")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !agentsQuery.data?.directories.home}
            onClick={() => void openFolder()}
          >
            {t("settings:iishkoSubagents_openFolder")}
          </Button>
          <Button size="xs" variant="accent" onClick={() => setCreating((v) => !v)}>
            {t("settings:iishkoSubagents_createAgent")}
          </Button>
        </div>
      </div>

      {creating ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createAgent();
          }}
        >
          <label className="text-ui-sm text-muted-foreground" htmlFor="iishko-agent-name">
            {t("settings:iishkoSubagents_agentNamePrompt")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="iishko-agent-name"
              autoComplete="off"
              spellCheck={false}
              placeholder="my-agent"
              value={agentName}
              onChange={(event) => setAgentName(event.currentTarget.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !agentName.trim()}>
              {t("settings:iishkoSubagents_createAgent")}
            </Button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}

      {agentsQuery.isPending ? (
        <p className="text-ui-sm text-muted-foreground">…</p>
      ) : agents.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">{t("settings:iishkoSubagents_empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {agents.map((agent) => (
            <AgentRow key={`${agent.source}:${agent.name}`} agent={agent} />
          ))}
        </ul>
      )}

      <p className="text-ui-xs text-muted-foreground/80">
        {t("settings:iishkoSubagents_formatHelp")}
      </p>
    </section>
  );
}
