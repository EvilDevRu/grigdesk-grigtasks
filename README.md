# GrigTasks driver for GrigDesk

Пакет `grigdesk-tasks-driver`, manifest ID **`grigdesk-tasks`**, TaskTracker **contract 1**.
Работает с GrigTasks `/api/v1`. Runtime использует только стандартные модули Node.js
и `TrackerHost`; исходники GrigDesk и GrigTasks нужны исключительно интеграционным тестам.
Поставляется исходный TypeScript для штатного loader GrigDesk, Node.js 24+.

## Подключение

Репозиторий: [EvilDevRu/grigdesk-grigtasks](https://github.com/EvilDevRu/grigdesk-grigtasks).
Релизы доступны в [Releases](https://github.com/EvilDevRu/grigdesk-grigtasks/releases).

Установите пакет через существующий механизм внешних драйверов GrigDesk.
В корне устанавливаемого каталога должны находиться `driver.json`, `driver.ts`, `src/`, `types/`
и `package.json`. При файловой установке имя каталога — `grigdesk-tasks` (ID манифеста).
Пакет не устанавливает себя, не меняет выбор доски и не перезапускает GrigDesk.

Настройки:

| Поле | Значение |
| --- | --- |
| `baseUrl` | HTTPS URL корня установки, например `https://tasks.example.org`; допустим префикс пути |
| `apiToken` | Персональный bearer token GrigTasks, secret; для записей нужны scopes `read` и `write` |

URL с userinfo, query, fragment и не-HTTPS отклоняются до сети. Токен не добавляется в URL,
не журналируется и не включается в ошибки. Транспорт использует `host.fetch`,
`redirect: 'error'`, `credentials: 'omit'`, caller AbortSignal для чтений.
`isConfigured` проверяет форму реквизитов; `testAuth` делает настоящий `/me`
и возвращает `{ok:true,userId:number}` либо `{ok:false,error:string}`.

В GrigDesk выбирается один внешний трекер; `own` остаётся доступным.
Связь проектов GrigTasks с проектами/репозиториями GrigDesk задаётся отдельно человеком:
совпадения имён или числовых ID не создают привязок.

## Возможности и HTTP mapping

Включены create, editing, comments, complete, delete, renew, users, projects, checklist, tags, review.
**attachments, timer, widgets = false**. Метода timer в экземпляре нет; widgets всегда `[]`.
Карточки и ответы мутаций не передают native ссылки вложений.

| contract1 | GrigTasks API / поведение |
| --- | --- |
| `accountIdentity` | Свежий `GET /me`; opaque scope `installationId:syncEpoch:nativeUserId` |
| `listTasks` | Все страницы `GET /tasks?view=assigned` |
| `getDashboard` | Отдельные `assigned`, `created`, `review`; все страницы каждого списка |
| `taskDetail` | `GET /tasks/:id`; checklist находится именно в detail |
| `taskPageData` | Все comments, tags, доступные подзадачи; attachments `[]` |
| `findUsers` | Участники доступных проектов плюс `/me`, поиск по имени без учёта регистра или точному ID |
| `listGroups` | Доступные неархивные проекты |
| `createTask` | `POST /tasks`, `groupId → projectId`, `responsibleId → assigneeId` |
| `updateTask` | Текущая version + `PATCH /tasks/:id`; отсутствующие поля сохраняются |
| `addComment` | `POST /tasks/:id/comments` с `{text}` |
| `updateTaskTags` | version задачи + `PUT /tasks/:id/tags`; `[]` явно очищает метки |
| `addChecklistItem` | Без parentId / с `'0'`: root через POST checklists; иначе POST checklists/:root/items |
| `update/deleteChecklistItem` | version самого node из GET checklists, затем PATCH/DELETE checklist-nodes/:node |
| `complete/approve/disapprove/renew` | GET transitions + POST выбранного edge по `submit/approve/reject/reopen` |
| `deleteTask` | version задачи + DELETE; успех только после подтверждённого ответа/receipt |
| `sourceUrl` | `/tasks/:id`, только если `/me.installation.webUrl` подтверждает тот же baseUrl |
| `probeTaskNumber` | 200 с совпадающим ID → exists; предметные task/project 404 → absent; прочее → unknown |

API-only возвращает пустую sourceUrl. Произвольные переходы и начало работы выполняются
в собственном web/API. `complete` на новой задаче не проводит скрытую цепочку стадий.
Отсутствующий либо неоднозначный semantic edge возвращает `transition_unavailable` без записи.

Native ID остаются положительными десятичными строками в пределах `Number.MAX_SAFE_INTEGER`.
Key задачи сохраняется отдельно. User ID в справочниках, участниках и формах остаётся native;
составной userId используется исключительно личным scope. Identity не кэшируется между вызовами,
поэтому новая установка/restore меняет источник favorites/seen/shelf.

| Native status | detail.status | statusKind |
| --- | --- | --- |
| new / todo | 2 | new |
| active / in_progress / custom active | 3 | in_progress |
| review | 4 | await_acceptance |
| done / custom done | 5 | done |
| cancelled | 5 | cancelled |

`statusId`, `statusCategory`, `nativeStatusKind`, `statusText` сохраняют собственную модель сервера.
Compatibility status используется существующей карточкой для выбора кнопок.
Описание API — plain text; поле `description` экранируется для HTML renderer старой карточки,
`rawDescription` содержит исходный текст. Отсутствующие подписи пользователей показывают native ID.
Roots и items чек-листа имеют общий namespace; `complete:false` не теряется.

## Повторы и ошибки

Каждый mutating invocation синхронно копирует input и фиксирует credentials/baseUrl.
После `/me` фиксируются installation/user/epoch; перед versioned записью читается версия
именно изменяемого ресурса. Затем ровно один раз создаются UUID, method/path, If-Match,
X-Sync-Epoch и сериализованное JSON body. Они неизменны во всех внутренних попытках.
Сервер дополнительно проверяет X-Expected-Installation-Id / X-Expected-User-Id.

При обрыве или 408/429/5xx перед повтором проверяется `GET /operations/:uuid` той же identity.
200 receipt восстанавливает подтверждённый `{status,body}`. Только служебный 404
`operation_not_found` допускает отсутствие receipt. Предметный 404, 401/403, 400/422,
409 version/idempotency/epoch conflict терминальны: новой версии, эпохи или ключа не будет.
Максимум три записи, backoff 100/200 ms, учитывается Retry-After.
Budget invocation 60s, отдельного запроса мутации 15s; чтений — 30s вместе с пагинацией/body.
После budget сеть больше не вызывается. JSON-ответ ограничен 16 MiB; повтор cursor — ошибка.

Исчерпание попыток даёт `operation_unknown` с UUID и сообщением
«Результат неизвестен; проверьте операцию в трекере перед повтором».
Это не утверждение об отсутствии эффекта. Сверьте UUID через собственный API/web/CLI трекера.

Существующий фасад нормализует `b24_bad_request` в HTTP400 и мутационный `task_not_found` в404.
Остальные ошибки внешнего класса, включая conflicts и unknown, становятся HTTP502
`tracker_error`; гарантированно сохраняется безопасный message, включая UUID.
Legacy GET detail имеет собственный 502 envelope даже для отсутствующей задачи — поведение ядра сохранено.

Contract1 не передаёт caller operationId, исходную версию давно открытого редактора или
epoch пользовательского намерения. **Новый вызов — новое намерение и новый UUID**,
в том числе одинаковые комментарии. Пакет не обещает offline-журнал после перезапуска,
dedup ручного повтора или защиту давно открытой формы. Такие гарантии принадлежат web GrigTasks.
Перенос проекта запрещён; чужой createdById отклоняется. Снять исполнителя в legacy UI
невозможно из-за действующего validator GrigDesk; используйте собственный web/API.

## Ограничения текущего API

Соисполнители и наблюдатели передаются атомарно вместе с полями задачи через POST/PATCH.
Одна операция использует один key/receipt и одно изменение версии. Отсутствующие массивы
сохраняют связи, явные [] очищают выбранную группу. Сервер проверяет tasks.assign отдельно
от tasks.update и отклоняет неактивных участников проекта до изменения задачи.

Плановый GET checklist-nodes пока отсутствует; GET checklists даёт точную node.version.
Общий users endpoint тоже отсутствует; используются существующие project members.
Подзадачи выбираются по parentId после полного чтения доступного проекта. На больших установках
эти обходы могут исчерпать read deadline и завершатся видимой ошибкой, без частичного списка.

## Проверки и упаковка

```bash
npm ci --ignore-scripts
GRIGDESK_ROOT=/absolute/read-only/cockpit npm test
npm run typecheck
GRIGDESK_ROOT=/absolute/read-only/cockpit \
  GRIGTASKS_ROOT=/absolute/read-only/grigtasks npm run test:integration
npm run pack:check
```

`npm test` включает protocol, identity, retry, facade/registry, реальные DTO decoders
и mounted TaskModal (через dev-only fixtures GrigDesk).
`npm run test:one -- tests/write-retry.test.mts` не требует внешних checkout.
Подготовка fixture обязательна; отсутствие checkout не считается RED.
Checkout GrigDesk должен содержать подготовленные `server/node_modules` и `web/node_modules`.
Все test workers запускаются последовательно через watchdog суммарного RSS process group
(2048 MiB, V8 heap 1024 MiB); лимит меняется `NODE_TEST_MAX_RSS_MB`.

Integration runner создаёт **собственный временный** PostgreSQL18 Docker container
(loopback, 512 MiB, 1 CPU), отдельную случайную БД и Fastify server на случайном порту.
Production handlers, migrations, permissions, tokens и SQL receipts настоящие.
Только transport seam переписывает тестовый HTTPS origin на loopback HTTP proxy;
TLS сертификаты и reverse proxy установки проверяются интегратором отдельно.
Proxy реально теряет HTTP ACK после commit. Проверяются task/comment counts, receipt,
workflow, чек-лист, tags/subtasks, facade DTO, token scope/revoke и смена epoch перед PATCH.
Собственный контейнер удаляется с `--volumes`, включая созданный им анонимный том PostgreSQL;
живые службы GrigDesk/GrigTasks не используются.
`DATABASE_URL` не наследуется; fixtures принимают только специальный loopback TEST_DATABASE_URL.

Для поставки не требуется transpilation: loader читает `driver.ts`; `npm pack` включает
только manifest, entrypoint, src, локальные types и README, без tests/node_modules.
Runtime npm dependencies отсутствуют.
