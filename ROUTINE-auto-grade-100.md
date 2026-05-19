# Routine: Auto-Grade 100% Quiz Submissions

**For use in Claude Code Web as a routine — executed by Claude using Notion MCP tools directly.**
No script file is run. Claude performs every step below using its built-in Notion MCP tools.

---

## Database IDs (verified raw API IDs — do not substitute collection:// format IDs)

| Name | ID |
|---|---|
| Knowledge Article Answer Keys | `3338e709-96c7-809a-9e6f-fc9d18bf14b7` |
| FSM Completed Quiz Tracker | `41f5edc5-8ddd-4522-9057-70f445e9f3fb` |

---

## Reference: Name property candidates

Quiz submission databases use different property names for the submitter's name.
Try these in order and use the first one that exists and is non-empty:
1. `Name`
2. `First & Last Name`
3. `First and Last Name: `
4. `Q1 First Last Name`

## Reference: Answer key question properties

Correct answers are stored as SELECT properties named `Q3`, `Q4`, `Q5`, `Q6`, `Q7`, `Q8`
on each answer key page. Not every quiz uses all six — only compare questions where
the answer key page has a non-empty SELECT value for that property.

## Reference: Answer key title suffix

Answer key pages are titled like `Making Units Unrentable – Knowledge Check Answer Key`.
Strip the suffix ` – Knowledge Check Answer Key` to get the clean quiz title
used in the Teams message and tracker matching.

## Reference: Name cleaning

Before comparing any submitter name against tracker property names, strip trailing
score suffixes. Examples of what to strip:
- `Joel Corrigan — 100% ✅` → `Joel Corrigan`
- `Adam Bertucco 100%` → `Adam Bertucco`
- `Name ✅` → `Name`

Strip pattern: remove anything matching ` — 100% ✅`, ` 100%`, ` ✅` and trailing whitespace.

## Reference: Fuzzy name matching

When matching a submitter name against FSM Completed Quiz Tracker property names:
- First try exact match (case-insensitive)
- If no exact match: same last name + first name prefix overlap is sufficient
  (e.g. "Sam Mojica" matches "Samuel Mojica", "Joel corrigan" matches "Joel Corrigan")
- Always clean the submission name before comparing (strip score suffixes as above)

---

## Steps

### Step 1 — Load the FSM Completed Quiz Tracker upfront

Before touching any submissions, query the FSM Completed Quiz Tracker
(`41f5edc5-8ddd-4522-9057-70f445e9f3fb`) and load ALL rows.

**Paginate:** if `has_more` is true in the response, keep fetching with `start_cursor`
until all rows are retrieved.

For each tracker row, record:
- The row's page ID
- The row's title (quiz topic name)
- All property names of type `date` and their current values
  (these are the FSM columns — one per person, named exactly after them)

Store this as your tracker map. You will use it in Step 5e without re-querying.

---

### Step 2 — Discover all answer key pages

Query the Knowledge Article Answer Keys database (`3338e709-96c7-809a-9e6f-fc9d18bf14b7`)
to get all pages.

**Paginate:** if `has_more` is true, keep fetching with `start_cursor` until all pages
are retrieved.

For each page:
- Record the page ID and full title
- Derive the clean quiz title by stripping ` – Knowledge Check Answer Key` from the end
- Read the correct answers from SELECT properties `Q3` through `Q8` — record only the
  ones that have a non-empty value set (skip blanks)
- If no Q3–Q8 properties have values, skip this quiz entirely and note it in the output

Result: a list of quizzes with pageId, fullTitle, cleanTitle, and correctAnswers for Q3–Q8.

---

### Step 3 — Find the submission database for each quiz

For each answer key page from Step 2, fetch the page's block children.

**Paginate:** if `has_more` is true on the blocks response, keep fetching with
`start_cursor` until all blocks are retrieved.

Look for a block of type `child_database` — this is the embedded submission database.
Record its block ID as the submissionDatabaseId for that quiz.

If no `child_database` block is found for a quiz, skip that quiz and note it in the output.

---

### Step 4 — Scan submissions and grade

For each quiz that has a submission database:

Query ALL rows from the submission database.
**Paginate:** if `has_more` is true, keep fetching with `start_cursor` until every
submission row has been retrieved. Do not stop at the first page of results.

For each submission row:

**Check if already graded:** Look at the `Teams Message` property (rich_text type).
If it is non-empty, skip this submission silently — it has already been handled.

**Get the submitter's name:** Check properties in this order:
`Name` → `First & Last Name` → `First and Last Name: ` → `Q1 First Last Name`
Use the first one that exists and is non-empty.
Clean the name by stripping score suffixes (see Reference above).
Extract the first name (first word only) for use in the Teams message greeting.

**Get the submission date:** Check properties `Submission Date`, `Date`, `Created Time`,
`Created` in that order. Fall back to the page's `created_time` field if none are found.
Format as `YYYY-MM-DD`.

**Grade the submission:** For each question where the answer key has a correct answer
(Q3–Q8 where the answer key SELECT is non-empty):
- Read the submission's SELECT value for that question
- Compare it to the answer key's correct value (case-insensitive)
- If the submission's SELECT is blank/empty OR does not match: count as wrong
- If it matches: count as correct

If correct count = total questions in answer key AND wrong count = 0:
→ Mark as PERFECT (100%)

Otherwise:
→ Mark as PARTIAL — record name, quiz, score (e.g. 4/6), which specific
  questions were wrong or blank, and submission page URL for the output at the end.

---

### Step 5 — Process each PERFECT submission

For each submission marked PERFECT in Step 4, perform the following writes in order.
Process one submission fully before moving to the next.
If any write fails, log the error, skip remaining writes for that submission, and continue.

**5a. Compose the message**

Hey [First Name]! Thanks for completing the [Clean Quiz Title] quiz — you got them all correct, great job! 🎉

Where [First Name] is the first word of the cleaned submitter name, and
[Clean Quiz Title] is the quiz title with ` – Knowledge Check Answer Key` stripped.

**5b. Append message to page body**

Add a new paragraph block to the submission page containing the message text.

**5c. Set the Teams Message property**

Update the submission page: set the `Teams Message` rich_text property to the
exact same message text composed in 5a.

**5d. Rename the page title**

Read the current title of the submission page (the title-type property, whichever it is).
Strip any existing score suffix (` — 100% ✅`, ` 100%`, ` ✅`) from the current title.
Set the new title to: [Cleaned Name] — 100% ✅

**5e. Update the FSM Completed Quiz Tracker**

Using the tracker map loaded in Step 1 (do not re-query):

Find the tracker row whose title best matches the current quiz's clean title.
Use this matching logic (normalize both strings to lowercase before comparing):
- `unrentable` in quiz title → match tracker row containing `unrentable`
- `unit` + `transfer` → match row containing both `unit` and `transfer`
- `create ticket` + `unit` → match row containing `ticket` and `unit`
- `create ticket` + `facility` → match row containing `ticket` and `facility`
- `associate` + `ledger` → match row containing `associate` and `ledger`
- `parking` → match row containing `parking`
- `tow` → match row containing `tow`
- `tenant` + `ledger` → match row containing `tenant` and `ledger`
- `teams` or `team` + `fac` → match row containing (`teams` or `team`) and `fac`

If no tracker row matches: log a warning for this submission and skip the tracker write.

In the matched tracker row, find the date property whose name matches the submitter's
cleaned full name using the fuzzy matching rules in the Reference section above.

If a matching property is found and its value is currently null/empty:
→ Write the submission date (YYYY-MM-DD) to that property.
→ Log: ✓ Tracker updated: "[Quiz row]" | [FSM column] → [date]

If the property already has a date value:
→ Do not overwrite. Log: ℹ Tracker already filled for [Name] / [Quiz] — skipping

If no matching property name is found:
→ Log: ⚠ No tracker column matching "[Name]" in row "[Quiz]" — skipping

---

### Step 6 — Output a summary

**A) AUTO-GRADED — 100% submissions processed this run**

For each PERFECT submission that was processed, show:
- Quiz name
- Submitter name
- Submission date
- Tracker result: ✓ written / ℹ already filled / ⚠ column not found / ⚠ row not found
- Direct link to the submission page

If none: (none — no ungraded 100% submissions found)

**B) PARTIAL SCORES — needs manual grading**

Group by quiz name. For each partial submission show:
- Submitter name
- Score (e.g. 4/6)
- Which questions were wrong or blank with detail
  (e.g. Q4: got "a) Unit Type" expected "b) Rentable", Q6: blank)
- Direct link to the submission page

If none: (none)

**C) TOTALS**
- Total auto-graded (100%)
- Total tracker cells written
- Total partial scores needing manual review
- Any quizzes skipped (no answer key properties or no child database found)

---

## Rules and guardrails

- **Never overwrite a non-empty Teams Message.** If `Teams Message` already has content, skip that submission entirely regardless of score.
- **Never overwrite a tracker date that already has a value.** Only fill empty/null cells.
- **Never modify answer key pages.** Read only.
- **Never create new rows** in the FSM Completed Quiz Tracker. Only update existing cells.
- **Blank answer = wrong answer.** A blank SELECT on a submission question counts as incorrect. Do not grant 100% for incomplete submissions.
- **Always paginate.** Any database query or block fetch where `has_more` is true must be continued with `start_cursor` until all results are retrieved.
- **Process one submission at a time.** Complete all writes for one submission before starting the next. This prevents partial states if a write fails mid-submission.
