# Synthetic demo mailbox

This harness creates a local inbox for product demos and development. GreenMail provides IMAP and SMTP, and Fluxmail keeps its demo configuration under `.context/demo-fluxmail`. Messages stay inside the local GreenMail container.

## Set up the workspace build

Docker must be running. From the repository root, run:

```bash
pnpm demo:setup
```

The setup command resets the mailbox, loads the sample messages, builds Fluxmail, creates an isolated administrator, and connects `demo@example.com`. Existing demo data is moved to a timestamped backup under `.context/demo-backups`.

Run Fluxmail commands against this isolated instance with:

```bash
pnpm demo:run -- accounts list
pnpm demo:run -- emails list --folder inbox
pnpm demo:run -- emails search "presentation"
```

## Test a published release

Pass a version to both setup and run:

```bash
pnpm demo:setup -- --version 0.6.0
pnpm demo:run -- --version 0.6.0 emails list --folder inbox
```

The script checks npm before setup and stores release data separately from workspace data.

## Connect an MCP client

Configure the client to start this command for the workspace build:

```text
/absolute/path/to/fluxmail/scripts/demo.sh run -- stdio --profile full
```

To use a published release, add `--version VERSION` before the separator:

```text
/absolute/path/to/fluxmail/scripts/demo.sh run --version 0.6.0 -- stdio --profile full
```

Restart the MCP connection after running setup again because setup creates a new session.

A useful demo prompt is:

> Check unread email for anything that could hold up today's presentation. Summarize what is needed, mark the message as read and starred, then draft a reply confirming that the final rollout slide will be sent by 3 p.m. Do not send it.

This flow covers search, message retrieval, message updates, and draft creation without sending mail.

## Local connection settings

| Setting  | Default            |
| -------- | ------------------ |
| Address  | `demo@example.com` |
| Username | `demo`             |
| Password | `fluxmail-demo`    |
| IMAPS    | `127.0.0.1:3993`   |
| SMTPS    | `127.0.0.1:3465`   |

GreenMail uses a self-signed certificate. The demo wrapper disables certificate verification only for the Fluxmail process it starts. Do not use that setting in a real deployment.

The defaults can be changed with environment variables:

| Variable                         | Purpose                          |
| -------------------------------- | -------------------------------- |
| `FLUXMAIL_DEMO_ADDRESS`          | Mailbox address                  |
| `FLUXMAIL_DEMO_NAME`             | Mailbox display name             |
| `FLUXMAIL_DEMO_ADMIN_NAME`       | Local administrator name         |
| `FLUXMAIL_DEMO_ADMIN_EMAIL`      | Local administrator address      |
| `FLUXMAIL_DEMO_PASSWORD`         | Fluxmail encryption password     |
| `FLUXMAIL_DEMO_MAILBOX_PASSWORD` | GreenMail password               |
| `FLUXMAIL_DEMO_HOST`             | IMAP and SMTP host               |
| `FLUXMAIL_DEMO_IMAPS_PORT`       | Local IMAPS port                 |
| `FLUXMAIL_DEMO_SMTPS_PORT`       | Local SMTPS port                 |
| `FLUXMAIL_DEMO_SMTP_PORT`        | Local plain SMTP port            |
| `FLUXMAIL_DEMO_WEB_PORT`         | GreenMail web and readiness port |
| `FLUXMAIL_DEMO_PROJECT`          | Docker Compose project name      |

For example:

```bash
FLUXMAIL_DEMO_ADDRESS=presenter@example.test \
FLUXMAIL_DEMO_NAME="Demo Presenter" \
FLUXMAIL_DEMO_WEB_PORT=8081 \
pnpm demo:setup
```

The script renders the fixture recipients for the configured address. The source messages remain unchanged under `demo/mailbox/messages`.

## Reset and stop

Reset the mailbox before another take:

```bash
pnpm demo:reset
```

This recreates GreenMail and restores the original sample messages. It does not reset the Fluxmail session. Run `pnpm demo:setup` when a clean Fluxmail instance is also needed.

Stop GreenMail when the demo is finished:

```bash
pnpm demo:stop
```
