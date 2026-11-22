// FILE: whatsNew/entries.ts
// Purpose: Curated "What's new" changelog rendered in the post-update dialog
// and the settings Release history view.
// Layer: static data consumed by `useWhatsNew`, `WhatsNewDialog`, and
// `ChangelogAccordion`.
//
// Authoring guide
// ---------------
//   - Prepend new releases so the file reads newest-first (the UI sorts too,
//     but keeping the source tidy makes PRs easier to review).
//   - `version` must match `apps/web/package.json#version` exactly. The
//     logic compares versions as semver and only opens the dialog when the
//     installed build has a curated entry here.
//   - `date` is rendered verbatim — pick whatever format you want (e.g.
//     `"Apr 18"`, `"2026-04-18"`), just be consistent release-to-release.
//   - Each feature takes an `id` (stable, unique per release), a short
//     `title`, a marketing `description`, and optionally an `image`
//     (absolute path from `apps/web/public`, e.g. `/whats-new/0.0.29/foo.png`)
//     plus `details` for the longer technical note shown under the image.

import type { WhatsNewEntry } from "./logic";

export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    version: "1.0.0",
    date: "2026-11-22",
    features: [
      {
        id: "iishko-provider",
        title: "ИИШКО IDE 1.0",
        description: "Встроенный провайдер ИИШКО — модели шлюза без настройки.",
      },
      {
        id: "iishko-telegram-account",
        title: "Подключение аккаунта через Telegram",
        description:
          "Войдите через бота @iishkogatewaybot или вставьте API-ключ — модели ИИШКО появятся в выборе модели.",
      },
      {
        id: "iishko-russian-ui",
        title: "Русский интерфейс",
        description: "Интерфейс на русском по умолчанию; английский — в настройках внешнего вида.",
      },
      {
        id: "iishko-theme",
        title: "Тёмная тема ИИШКО",
        description: "Графитовая тема с одним жёлтым акцентом и новые иконки приложения.",
      },
    ],
  },
];
