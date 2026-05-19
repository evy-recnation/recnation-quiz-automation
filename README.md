# RecNation Quiz Reconciliation

This script checks all FSM quiz submissions in Notion and produces a report that answers four questions:

1. Which submissions still need to be graded?
2. Which have been graded but the results haven't been sent yet?
3. Which completions are missing from the tracker databases?
4. How many people have fully finished each quiz end-to-end?

---

## What you need before running

- **Node.js** installed on your computer (version 16 or later). If you're not sure whether you have it, open a terminal and type `node --version`. If you see a version number, you're good.
- **Your Notion integration token** (see below).

### Getting your Notion token

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) (you must be logged in as a workspace admin).
2. Open the integration named **Claude Code Script** (or whichever internal integration has been connected to the quiz databases).
3. Copy the **Internal Integration Token** — it starts with `ntn_`.

> This token is a password. Do not share it or commit it to the repository.

---

## How to run

Open a terminal, navigate to this folder, and run:

```
NOTION_TOKEN=ntn_your_token_here node notion-quiz-reconciliation.js
```

Replace `ntn_your_token_here` with the token you copied above.

The script typically takes 30–60 seconds to run because it reads every submission page.

### Dry-run mode (safe preview)

If you want to see what the script *would* write back to Notion without actually changing anything, add `--dry-run`:

```
NOTION_TOKEN=ntn_your_token_here node notion-quiz-reconciliation.js --dry-run
```

---

## What the report sections mean

### A) NEEDS GRADING
Submissions where the **Teams Message** field is blank — meaning no feedback has been written yet.

For the **Making Units Unrentable** quiz specifically, each entry is tagged:
- `[HAS FEEDBACK]` — someone already wrote feedback directly on the page before the Teams Message workflow existed. You just need to send the Teams message to close it out.
- `[BLANK]` — the page is completely empty. It needs to be graded from scratch.

---

### B) GRADED BUT NOT SENT
Submissions where the **Teams Message** field has content but the **Results Sent via Teams** checkbox is not checked. The grading is done — it just hasn't been sent to the FSM yet.

---

### C) TRACKER GAPS
Submissions that are fully complete (graded + sent) but are missing a completion date in either the **FSM Completed Quiz Tracker** or the **Quiz Focused Tracker**.

This section only flags **active FSMs** — people who appear in the FSM Directory with no Last Day filled in. Former employees and non-FSM submitters are excluded and listed separately so you can see they were considered.

When the script runs in live mode (not dry-run), it automatically writes the missing completion dates back to both tracker databases for anyone in this section.

---

### D) SUMMARY
A table showing, for each quiz:
- **Total Submissions** — everyone who submitted the quiz
- **Fully Complete** — graded + sent + logged in the tracker
- **Tracker Gaps** — active FSMs whose completion is graded and sent but still missing from the tracker (these get auto-filled on each run)

---

### E) UNRENTABLE DEEP-DIVE
An extra breakdown for the Making Units Unrentable quiz specifically, since it has the most backlog. Shows a count and list of pre-reviewed vs. truly blank ungraded submissions with direct links to each page.

---

## Databases this script reads and writes

| Database | What it does |
|---|---|
| Knowledge Article Answer Keys | Source of truth for which quizzes exist |
| Response databases (one per quiz) | Where FSM quiz submissions live |
| FSM Completed Quiz Tracker | Row per quiz, column per FSM — completion dates |
| Quiz Focused Tracker | Row per FSM, column per quiz — completion dates |
| FSM Directory | Used to filter out former/non-FSM submitters from gap reporting |

The script **only writes** to the two tracker databases, and only to fill in blank completion date cells for submissions that are already fully graded and sent. It never modifies submission pages or the answer keys.
