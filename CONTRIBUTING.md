# Участие в разработке

Принимаем небольшие точечные правки: исправления ошибок, надёжность, производительность и сопровождение. Крупные PR без чёткой цели и смены направления проекта могут быть закрыты без обсуждения.

## Требования

- Bun 1.4.5
- Node 24.13.1
- Windows, macOS или Linux; для сборки Windows-установщика нужен Visual Studio Build Tools.

## Запуск

```bash
bun install
bun run dev:desktop
```

## Проверки перед PR

```bash
bun run fmt:check
bun run lint
bun run typecheck
bun run brand:check
bun run i18n:check
bun run test
```

Для тестов всегда `bun run test`, никогда `bun test`: это другой раннер. Прогоняйте минимально нужные файлы при работе и полный набор перед отправкой.

## Правила кода

- Размер текста в интерфейсе берётся из токенов `text-ui*` (см. `apps/web/src/index.css`), а не из фиксированных `text-sm` или `text-[11px]`.
- Переиспользуйте существующие компоненты, хуки и функции вместо нового кода с нуля.
- Каждая строка интерфейса идёт через i18n (ru и en).
- Дополнительные правила для ИИ-агентов — в [AGENTS.md](./AGENTS.md).

## Безопасность

- Не коммитьте секреты, токены, ключи и личные данные.
- Уязвимости не публикуйте в открытых issue: напишите в @iishkogatewaybot.

## Ошибки и предложения

Заводите задачи в Gitea: [git.reformboss.com/reform/iishko-ide/issues](https://git.reformboss.com/reform/iishko-ide/issues), либо пишите в @iishkogatewaybot.
