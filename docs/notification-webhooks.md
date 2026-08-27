# Notification webhooks

Yuvomi can deliver every native server-side notification to a generic HTTP
webhook or to songquanpeng/message-pusher, in addition to Web Push, Gotify, and
ntfy. This includes task, calendar, inventory, pantry, subscription, medication,
and task-comment mention notifications. Reminder notifications use the existing
delivery tracking, retry, and deduplication flow; immediate medication and
mention notifications remain best-effort.

## Configure a channel

Open **Settings → Personal → Notifications**. The page has two groups:

- **Personal notifications** are visible and manageable by the current user.
  Personal scope currently allows only Webhook and message-pusher, and a personal
  endpoint is delivered only to its owner.
- **Household notifications** are visible and manageable by administrators. They
  are delivered to every household member who is eligible for the notification.
  Ordinary users do not see this group.

In either group, select **Add channel**, choose a provider, enter its endpoint and
credentials, enable it, and use **Send test**. Personal Webhook and message-pusher
channels can be configured independently from household channels. If an
administrator enables both a personal and a household channel targeting the same
destination, two deliveries are expected; Yuvomi does not silently deduplicate
different configured channels.

For Webhook, enter the complete HTTP or HTTPS endpoint URL. An optional Bearer
token is stored as a write-only secret and sent as
`Authorization: Bearer <token>`. An optional payload template lets the receiver
use its own JSON schema; an empty template keeps the default Yuvomi body.

For `message-pusher`, enter the message-pusher base URL and username, then choose
GET or POST. POST JSON is the default and recommended format. The adapter sends
`title` plus either Markdown `content` or `description`, the configured
`channel`, and the write-only token. Its optional message template controls the
contents of that selected message field.

The message-pusher endpoint is built as `/push/<username>`. GET puts the fields
in the query string. POST JSON sets `Content-Type: application/json`; POST Form
uses form encoding. POST can also put `token` in the URL query when explicitly
selected. This follows the upstream API contract.

The receiver must return a successful HTTP status (`2xx`). Failed deliveries
are retried by the notification scheduler with the same backoff and attempt
limit used for Gotify and ntfy. Secrets are never returned by the channel API
or written into delivery error messages.

## Request format

Yuvomi sends an HTTP `POST` with `Content-Type: application/json`:

```json
{
  "event": "notification",
  "notification": {
    "title": "Tasks",
    "body": "Take out the bins",
    "description": "Put glass in the blue container.",
    "details": "category: home\npriority: high\nstatus: open",
    "entityType": "task",
    "entityId": 42,
    "dueDate": "2026-08-27",
    "dueTime": "18:30",
    "startDate": "2026-08-27",
    "startTime": "09:00",
    "endDate": "",
    "endTime": "",
    "remindAt": "2026-08-27T18:00:00.000Z",
    "sentAt": "2026-08-27T18:00:02.000Z",
    "url": "/tasks",
    "tag": "reminder-42",
    "priority": "default",
    "category": "home",
    "taskPriority": "high",
    "status": "open",
    "location": "",
    "allDay": null
  },
  "sentAt": "2026-08-06T20:30:00.000Z"
}
```

The outer `sentAt` is generated when the Webhook request is sent. The
notification's `sentAt` is the scheduler timestamp passed to templates;
`remindAt` is the reminder time stored by Yuvomi. The `tag` identifies the
reminder and can be used by receivers for their own deduplication. The `url` is
relative to the Yuvomi application.

## Payload template

The default body works for receivers that accept arbitrary JSON, such as Home
Assistant or n8n. Services with a schema of their own reject it: a Discord
webhook requires `content` or `embeds` and answers anything else with
`400 Cannot send an empty message`.

Rather than shipping an adapter per service, the channel takes a template and
the same generic provider covers all of them. Enter the JSON body the receiver
expects and use the fields below where the notification's values belong:

| Field | Meaning |
|---|---|
| `{{title}}` | Module/source title, such as Tasks or Calendar |
| `{{body}}` | Main notification text |
| `{{description}}` | Task or event description |
| `{{details}}` | Extra task/event details, one item per line |
| `{{entityType}}`, `{{entityId}}` | Source type and local record ID |
| `{{dueDate}}`, `{{dueTime}}` | Task deadline; empty when unavailable |
| `{{startDate}}`, `{{startTime}}` | Task start or event start |
| `{{endDate}}`, `{{endTime}}` | Event end |
| `{{remindAt}}` | Stored reminder time |
| `{{sentAt}}` | Scheduler timestamp used for this notification |
| `{{url}}`, `{{tag}}` | Relative Yuvomi target and reminder tag |
| `{{priority}}` | Notification transport priority |
| `{{category}}`, `{{taskPriority}}`, `{{status}}` | Task metadata |
| `{{location}}`, `{{allDay}}` | Event location and all-day flag |

Use quoted placeholders for text values. The settings page shows a copyable
example for each scope. Personal channels use a compact task/event message:

```json
{"content":"🔔 {{title}} — {{body}}\n📄 {{description}}\n📅 {{dueDate}} {{dueTime}}\n🚀 {{startDate}} {{startTime}}\n🔗 {{url}}"}
```

Household channels receive notifications from every module, so their example
also includes the generic system context and delivery fields:

```json
{"content":"🔔 {{title}} — {{body}}\n📄 {{description}}\n📅 {{dueDate}} {{dueTime}}\n🚀 {{startDate}} {{startTime}}\n🧩 {{entityType}} #{{entityId}}\n📝 {{details}}\n⏰ {{remindAt}}\n📤 {{sentAt}}\n🔗 {{url}}"}
```

The examples remain in the input placeholder so an empty template still keeps
Yuvomi's default body. Since a placeholder cannot be selected with the mouse
or keyboard, **Copy example** beside either template field copies the complete
visible example, including Emoji characters, ready to paste into the field.

Notes:

- Values are JSON-escaped before they are inserted, so a reminder title
  containing a quote, a backslash or a line break cannot break the surrounding
  JSON.
- A placeholder with no value (for example `{{url}}` on a reminder that carries
  none) becomes an empty string.
- The template is checked when you save it: it must produce valid JSON, may use
  only the fields in the table above, and is limited to 4096 characters. A
  template that would only fail at delivery time is rejected in the form. The
  check looks at anything shaped like a placeholder, so a typo such as
  `{{task-title}}` is caught rather than delivered as literal text.
- The endpoint URL is used exactly as entered, including a trailing slash.
- Leave the field empty to keep the default body. Existing webhook channels are
  unaffected.

## message-pusher example

With base URL `https://push.example.com`, username `alice`, channel `lark`, and
POST JSON selected, a delivery is sent to:

```http
POST https://push.example.com/push/alice
Content-Type: application/json

{"title":"Tasks","content":"Reply to colleague","channel":"lark","token":"..."}
```

The token is never returned by the API or included in Yuvomi error messages.
If message-pusher returns HTTP success with `success: false`, Yuvomi still
records the delivery as failed.

### message-pusher template

The message-pusher template is plain text, so it uses the same placeholders and
does not need JSON escaping. A useful default is:

```text
🔔 {{title}}
📌 {{body}}
📄 {{description}}
⏰ Due: {{dueDate}} {{dueTime}}
🚀 Start: {{startDate}} {{startTime}}
🔗 {{url}}
```

The selected `content` or `description` field receives the rendered result. If
the template is empty, the existing single-line message behavior is preserved.

## Security notes

- Use HTTPS whenever the endpoint is outside a trusted private network.
- Give the webhook a dedicated, revocable token with only the permissions it
  needs.
- Treat notification bodies as household data. The receiving service gets the
  reminder title and, for subscriptions, the name, amount, currency, and next
  renewal date.
- Rotate a token by entering a replacement in the channel form. Leaving the
  field empty preserves the stored token.
- Prefer POST JSON for message-pusher. GET and POST query-token modes expose the
  token to URL logging in reverse proxies and web servers.
