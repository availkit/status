# AvailKit public status

Source for independent, read-only observations of four public AvailKit endpoints. The intended informational Pages address is <https://availkit.github.io/status/>. This repository contains only the monitor, static status page, public observations and incident process. It contains no application or SDK source, account data or credentials.

The initial `data/state.json` is empty. There is no historical availability claim before the first real observation. Read the last UTC observation and its explicit 20-minute expiry; without a recent observation, current status is unknown.

## Source-only publication state

This source snapshot deliberately withholds the reviewed
`.github/workflows/observe.yml` file pending owner workflow-file write authority.
Keep repository Actions disabled. Publishing these files does not activate
probes, alerts, scheduled jobs or Pages, and does not establish notification
receipt. The intended Pages address above is not a delivery claim.

The monitor design and future activation procedure below describe the reviewed
workflow; that workflow is absent from this snapshot. The export manifest lists
only the files actually present and identifies the withheld workflow by digest.
The empty observation and alert files remain seeds, not measured history. No
runtime token, new monitoring account or application credential is included.

## What runs

Once separately authorized and enabled, the reviewed workflow requests a check at minutes 2, 7, 12, …, 57 UTC and supports manual dispatch. Each normal run performs exactly one GET to each fixed endpoint, with redirects refused, no authentication/cookies, a transparent monitor user agent, an eight-second whole-response deadline and a bounded body:

| Component | Exact URL | Validation | Body limit |
| --- | --- | --- | --- |
| Integration API | `https://api.availkit.com/ready` | HTTP200 JSON, `status=ready`, `backend=postgresql`, integer schema version | 4KiB |
| Application | `https://app.availkit.com/` | HTTP200 HTML with AvailKit title, root container and script | 256KiB |
| Developer documentation | `https://availkit.dev/` | HTTP200 HTML with AvailKit title, main content and canonical public AvailKit link | 256KiB |
| Marketing | `https://availkit.com/` | Same public reading checks | 256KiB |

A successful shell check does not run JavaScript or verify passkeys, accounts, SDK operations, booking mutations or delivery. A failed check establishes only that this external check failed. Network errors, body limits and timeouts are unconfirmed results. No alternate target, WAF workaround, redirect following or automatic request retry is used.

Each retained sample contains its GitHub run ID, UTC **sample start** and four results: component ID, pass/fail/unknown, finite reason code, optional HTTP status and bounded duration. No response body, headers, cookies, IP address or thrown error text is retained. At most 288 actual samples are in the working state (256KiB maximum). The status view counts the latest 24 hours beginning no earlier than the first observation. It reports sample outcomes separately from completed five-minute windows without a retained observation; it does not calculate an uptime percentage. Several manual samples in one window do not fill other windows.

The state is committed to `data/state.json` using the GitHub Contents API with the current SHA as a compare-and-swap condition. A lost acknowledgement is reconciled by reading exact state bytes, never by repeating the PUT. A rerun whose ID is still retained republishes its observation without sending new public probes. The public JSON names its generation time and the observation’s `unknownAfter` time; consumers must evaluate freshness themselves rather than treating the generated state as current forever. Git history retains earlier **public** observations; this is not a promise of permanent or immutable archival storage.

The workflow uses standard public-repository GitHub runners and the required Pages deployment artifact, with one-day artifact retention. It performs no application build, dependency install, test suite, SDK packaging or package publication. The only projection is allowlisted static HTML/CSS/JavaScript/fonts and bounded public JSON. `_site` is disposable output. Application deployment remains separate.

## Alerts and incident handling

Before activation, create these reserved repository labels: `monitor-api`, `monitor-app`, `monitor-docs`, `monitor-home`, `monitor-drill`. Use them only on the corresponding canonical monitor thread. Preserve its `availkit-monitor:v1` marker and label. Duplicated canonical markers or a full 100-issue result page require manual reconciliation; the monitor stops rather than guessing. Workflow failures are visible in Actions.

Two consecutive non-passing observations no more than 20 minutes apart open or reopen one canonical issue per component. One passing observation closes that issue. A lone failed/unconfirmed sample or a gap does not close an existing concern. There are no periodic comments or unrelated messages. The issue is reused; its event timeline records actual close/reopen times while operator comments remain intact. A tiny separate `data/alerts.json` reserves each canonical creation durably before its one POST. A lost create/PATCH response is read-reconciled; unresolved outcomes fail the job without a repeated mutation. The next run searches again; an unresolved creation reservation prevents another POST, even when a negative read cannot prove whether the earlier request committed. A crash between reservation and POST can therefore require operator attention rather than a duplicate issue. Stop and join all monitor jobs before any deliberate owner repair; preserve the reservation unless the owner independently establishes that no earlier creation can still land. Never clear it automatically.

An issue is a detection thread, not a complete impact determination. Operators:

1. Check the UTC observation, public run and whether the concern is a drill. Verify scope independently before declaring customer impact.
2. Add a comment with known impact, unknowns, detection time and next investigation step. Do not paste response bodies, credentials, account/customer data or private URLs.
3. Append UTC updates with confirmed facts and actions. Distinguish detection time from the unknown onset of an outage.
4. Check the actual recovery and remaining impact. Automatic closure means the public check passed; it does not prove all customer impact is resolved. Add that distinction to the incident thread.
5. Record follow-ups with owner and completion evidence. Use the incident issue form for a broader incident and link the component thread.

Configure the owner's own repository notification subscription or assignment during activation, then verify a bot-created controlled drill appears in the owner's actual GitHub notifications. Workflow/issue success alone does not prove notification receipt. Email delivery depends on the owner's GitHub notification settings and is not promised by this monitor. There is no email, Slack, webhook secret or added notification account in the workflow.

For a controlled alert delivery test, manually dispatch `drill-failure`, inspect the separate `[DRILL]` issue and recipient notification, then dispatch `drill-recovery`. These modes perform **zero public endpoint probes**, do not alter normal observations or deploy the status page, and use only `monitor-drill`. No real incident or historic outage is asserted. Do not change production to test detection.

## Activation and local checks

Export only `public-export.json`'s exact files from the maintained private source into a **fresh** public `availkit/status` repository. Do not publish private repository history, configuration, evidence or generated output. Review the fresh tree and workflows before enabling Actions. The application stays private. For later source updates, preserve the public repository’s actual `data/state.json` and `data/alerts.json`; do not overwrite them with the empty seed files. Any deliberate history reset must be declared.

Enable Pages with GitHub Actions as its source, allow the `github-pages` environment to deploy from `main`, create the reserved labels and verify the owner's subscription. The job checks repository and main-branch identity. No custom domain or paid service is needed. The only credential is the ephemeral repository-scoped `GITHUB_TOKEN`; permissions are explicit in the workflow. Do not add user PATs, application credentials or customer data.

The injected tests can run offline with Node24+:

```sh
node --test --test-isolation=none --test-reporter=tap test/monitor.test.mjs
```

These tests are for operator verification and are deliberately absent from the scheduled workflow. They cover fixed send-once GETs, body/deadline bounds, content checks, finite redaction, retention/coverage/staleness, real transition logic, lost issue/state acknowledgements, duplicate guards, private API transport and no-JS output. Activation acceptance additionally requires an actual read-only run, Pages deployment, controlled alert/recovery and owner notification receipt. Source or tests alone are not that acceptance.

## Dependency and service limits

GitHub may delay or drop scheduled jobs, especially at busy times. Five minutes is the minimum schedule interval; the off-hour cron is a request, not a timing guarantee. Public-repository schedules can be disabled after 60 days without activity. Legitimate observation commits normally create activity; still inspect whether the workflow is enabled. Workflow concurrency is serialized, and GitHub can replace pending runs under load. Missing observations remain unknown.

The monitor and Pages are independent of the AvailKit application server, but both depend on GitHub. A GitHub failure can prevent probes, alerts and publishing together. This is not a separate dead-man alert, continuous uptime monitor, SLA, security certification or support-response commitment. The page's JavaScript only computes staleness and an optional non-sensitive theme preference; it sends no background requests. Without JavaScript the last UTC observation and explicit expiry remain readable.

GitHub Pages hosts this informational status site only; no SaaS transactions, accounts or application are hosted here. Public standard runners are free under the cited GitHub policy; larger runners are not used. Pages and artifact quotas still apply. The site is small and artifact retention is one day. Do not silently provision paid capacity.

Official policy references, verified 27 October 2026:

- [Schedule semantics, delays/drops, default branch and inactivity](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Custom Pages workflow, single job without a build, deployment permissions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Public standard runners and billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Pages use and size/deployment limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Workflow notification delivery and scheduled-run recipients](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)

Official action tags were resolved read-only to immutable commit SHAs on 27 October 2026. Updates require source review and an explicit SHA change. The workflow does not follow moving action tags.
