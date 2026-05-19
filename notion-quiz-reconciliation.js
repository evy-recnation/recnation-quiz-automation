#!/usr/bin/env node
/**
 * notion-quiz-reconciliation.js
 *
 * Discovers all active quizzes from the Answer Keys database, scans every
 * response database for submissions, cross-references both trackers, and
 * prints a five-section reconciliation report.  Optionally writes missing
 * completion dates back to both trackers for fully-complete submissions.
 *
 * Usage:
 *   NOTION_TOKEN=secret_... node notion-quiz-reconciliation.js [--dry-run]
 *
 * --dry-run  Print what would be written without actually calling the API.
 */

'use strict';

const https   = require('https');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error('ERROR: Set NOTION_TOKEN environment variable before running.');
  process.exit(1);
}

const ANSWER_KEYS_DB     = '3338e709-96c7-809a-9e6f-fc9d18bf14b7';
const FSM_TRACKER_DB     = '41f5edc5-8ddd-4522-9057-70f445e9f3fb';
const FOCUSED_TRACKER_DB = 'e308e709-96c7-838e-a50b-8194b02e9a40';

const UNRENTABLE_KEYWORD = 'unrentable';

// Submission name property candidates (tried in order)
const NAME_PROPS = [
  'Name',
  'First & Last Name',
  'First and Last Name: ',
  'Q1 First Last Name',
];

// Block types that count as grader-written feedback
const FEEDBACK_BLOCK_TYPES = new Set([
  'paragraph', 'callout', 'quote',
  'heading_1', 'heading_2', 'heading_3',
  'bulleted_list_item', 'numbered_list_item', 'to_do',
]);

// Maps quiz fingerprint → Quiz Focused Tracker column name
// (Focused Tracker: row = FSM person, column = quiz)
const FP_TO_FOCUSED_COL = {
  'unrentable':      'Making Units Unrentable Quiz',
  'ticket-unit':     'Create Ticket Under Unit Quiz',
  'ticket-facility': 'Create Ticket Under Facility Quiz',
  'assoc-ledger':    'Associate Ledger Quiz',
  'teams-fac-ops':   'Teams Fac Ops Quiz',
  'unit-transfer':   'Unit-to-Unit Transfer — FSM Process',
  'parking':         'HubSpot: Parking Issue FSM',
  'tow-signage':     'Tow Signage & Private Property Towing',
  'tenant-ledger':   'Tenant Ledger Quiz',
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400)
            reject(new Error(`Notion API ${res.statusCode}: ${JSON.stringify(json)}`));
          else resolve(json);
        } catch (e) { reject(new Error(`JSON parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get    = (path)       => request('GET',   `/v1/${path}`, null);
const post   = (path, body) => request('POST',  `/v1/${path}`, body);
const patch  = (path, body) => request('PATCH', `/v1/${path}`, body);

// ─── Pagination ───────────────────────────────────────────────────────────────

async function getAllBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : '';
    const res = await get(`blocks/${pageId}/children${qs}`);
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function getAllRows(dbId) {
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await post(`databases/${dbId}/query`, body);
    rows.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// ─── Name cleaning ────────────────────────────────────────────────────────────

/**
 * Strip trailing score/emoji suffixes from submission names.
 * e.g. "Adam Bertucco 100%", "Joel Corrigan — 100% ✅", "Name ✅"
 */
function cleanName(s) {
  return (s || '')
    .replace(/\s*[—\-]+\s*\d{1,3}%[\s✅]*.*/u, '')  // " — 100% ✅ ..."
    .replace(/\s*\d{1,3}%[\s✅]*.*/u, '')             // " 100% ..."
    .replace(/\s*✅.*/u, '')                           // " ✅ ..."
    .trim();
}

/**
 * Fuzzy name match: exact > same last name + first-name prefix overlap.
 * Handles "Samuel Mojica" vs "Sam Mojica", "Joel corrigan" vs "Joel Corrigan".
 */
function nameMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const aw = na.split(' '), bw = nb.split(' ');
  if (aw.length < 2 || bw.length < 2) return false;
  const aLast = aw[aw.length - 1], bLast = bw[bw.length - 1];
  if (aLast !== bLast) return false;
  const aFirst = aw[0], bFirst = bw[0];
  return aFirst.startsWith(bFirst) || bFirst.startsWith(aFirst);
}

// ─── Quiz fingerprinting ──────────────────────────────────────────────────────

/**
 * Returns a short canonical token for each quiz so that "Making Units
 * Unrentable: Full Process..." and "Making Units Unrentable Quiz" both map
 * to the same fingerprint regardless of title variation.
 */
function quizFingerprint(s) {
  const n = norm(s);
  if (n.includes('unrentable'))                                      return 'unrentable';
  if (n.includes('unit') && n.includes('transfer'))                  return 'unit-transfer';
  if (n.includes('create') && n.includes('ticket') && n.includes('unit')) return 'ticket-unit';
  if (n.includes('create') && n.includes('ticket') && n.includes('facility')) return 'ticket-facility';
  if (n.includes('associate') && n.includes('ledger'))               return 'assoc-ledger';
  if ((n.includes('teams') || n.includes('team')) && n.includes('fac')) return 'teams-fac-ops';
  if (n.includes('parking'))                                         return 'parking';
  if (n.includes('tow'))                                             return 'tow-signage';
  if (n.includes('tenant') && n.includes('ledger'))                  return 'tenant-ledger';
  // "Untitled" quiz — inferred as Tenant Ledger based on tracker schema
  if (n === 'untitled' || n === '(untitled)' || n === '')            return 'tenant-ledger';
  return n.split(' ').slice(0, 4).join('-');
}

// ─── Property extractors ──────────────────────────────────────────────────────

function norm(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getTitle(props) {
  for (const p of Object.values(props)) {
    if (p.type === 'title' && p.title?.length > 0)
      return p.title.map((t) => t.plain_text).join('').trim();
  }
  return '';
}

function getPersonName(props) {
  for (const key of NAME_PROPS) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'title'     && p.title?.length     > 0) return p.title.map((t) => t.plain_text).join('').trim();
    if (p.type === 'rich_text' && p.rich_text?.length > 0) return p.rich_text.map((t) => t.plain_text).join('').trim();
  }
  return '(unknown)';
}

function getDate(props, createdTime) {
  for (const key of ['Submission Date', 'Date', 'Created Time', 'Created']) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'date'         && p.date)         return p.date.start;
    if (p.type === 'created_time' && p.created_time) return p.created_time.slice(0, 10);
  }
  return createdTime ? createdTime.slice(0, 10) : '?';
}

function isTeamsMessageFilled(props) {
  const p = props['Teams Message'];
  if (!p) return false;
  if (p.type === 'rich_text') return p.rich_text?.length > 0;
  if (p.type === 'url')       return !!p.url;
  if (p.type === 'email')     return !!p.email;
  return false;
}

function isResultsSentViaTeams(props) {
  const p = props['Results Sent via Teams'];
  return p?.type === 'checkbox' && p.checkbox === true;
}

function pageUrl(pageId) {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

// ─── Step 1: Discover quizzes ─────────────────────────────────────────────────

async function discoverQuizzes() {
  console.log('Step 1 — Querying Answer Keys database…');
  const rows = await getAllRows(ANSWER_KEYS_DB);
  console.log(`  Found ${rows.length} answer key row(s).`);

  const quizzes = [];
  for (const row of rows) {
    const quizName = getTitle(row.properties);
    const pageId   = row.id;
    let responseDatabaseId = null;
    try {
      const blocks  = await getAllBlocks(pageId);
      const childDb = blocks.find((b) => b.type === 'child_database');
      if (childDb) responseDatabaseId = childDb.id;
    } catch (e) {
      console.warn(`  Warning: could not read blocks for "${quizName}": ${e.message}`);
    }
    quizzes.push({ quizName, pageId, responseDatabaseId });
  }
  return quizzes;
}

// ─── Step 2: Scan response databases ─────────────────────────────────────────

async function scanResponses(quizzes) {
  console.log('\nStep 2 — Scanning response databases…');
  const submissions = [];
  for (const { quizName, responseDatabaseId } of quizzes) {
    if (!responseDatabaseId) {
      console.log(`  [SKIP] "${quizName}" — no child_database found`);
      continue;
    }
    let rows;
    try { rows = await getAllRows(responseDatabaseId); }
    catch (e) { console.warn(`  Warning: "${quizName}": ${e.message}`); continue; }

    console.log(`  "${quizName}": ${rows.length} submission(s)`);
    for (const row of rows) {
      const rawName     = getPersonName(row.properties);
      const name        = cleanName(rawName);
      const date        = getDate(row.properties, row.created_time);
      const teamsMsg    = isTeamsMessageFilled(row.properties);
      const resultsSent = isResultsSentViaTeams(row.properties);
      submissions.push({
        quizName, name, date, teamsMsg, resultsSent,
        url: pageUrl(row.id), pageId: row.id,
        fp: quizFingerprint(quizName),
        hasFeedback: null,
      });
    }
  }
  return submissions;
}

// ─── Step 2b: Feedback check for ungraded Unrentable ─────────────────────────

async function checkFeedbackContent(pageId) {
  try {
    const blocks = await getAllBlocks(pageId);
    for (const block of blocks) {
      if (!FEEDBACK_BLOCK_TYPES.has(block.type)) continue;
      const rt = block[block.type]?.rich_text;
      if (rt?.length > 0 && rt.some((t) => t.plain_text.trim())) return true;
    }
  } catch { /* assume no feedback */ }
  return false;
}

async function enrichUnrentableFeedback(submissions) {
  const targets = submissions.filter(
    (s) => !s.teamsMsg && norm(s.quizName).includes(UNRENTABLE_KEYWORD)
  );
  if (!targets.length) return;
  console.log(`\nStep 2b — Checking page bodies of ${targets.length} ungraded Unrentable submission(s)…`);
  for (let i = 0; i < targets.length; i += 5) {
    const batch   = targets.slice(i, i + 5);
    const results = await Promise.all(batch.map((s) => checkFeedbackContent(s.pageId)));
    batch.forEach((s, idx) => { s.hasFeedback = results[idx]; });
    process.stdout.write(`  ${Math.min(i + 5, targets.length)}/${targets.length}\r`);
  }
  console.log('  Done.                    ');
}

// ─── Step 3: Read trackers (correct schema) ───────────────────────────────────
//
// FSM Completed Quiz Tracker  — row = quiz,   columns = FSM persons  → date
// Quiz Focused Tracker        — row = person, columns = quizzes      → date

async function readFSMTracker() {
  console.log('  Reading FSM Completed Quiz Tracker…');
  const rows = await getAllRows(FSM_TRACKER_DB);
  console.log(`    ${rows.length} quiz row(s)`);

  const trackedPairs = []; // {fsmName (clean), fp, date}
  const fsmRows = [];      // for write-back: {rowId, subject, fp, personDates{col→date|null}}

  for (const row of rows) {
    const subject = getTitle(row.properties);
    const fp      = quizFingerprint(subject);
    const personDates = {};

    for (const [key, prop] of Object.entries(row.properties)) {
      if (prop.type !== 'date') continue;
      personDates[key] = prop.date ? prop.date.start : null;
      if (prop.date) {
        trackedPairs.push({ fsmName: cleanName(key), fp, date: prop.date.start });
      }
    }
    fsmRows.push({ rowId: row.id, subject, fp, personDates });
  }
  return { trackedPairs, fsmRows };
}

async function readFocusedTracker() {
  console.log('  Reading Quiz Focused Tracker…');
  const rows = await getAllRows(FOCUSED_TRACKER_DB);
  console.log(`    ${rows.length} person row(s)`);

  const trackedPairs = [];
  const focusedRows  = [];

  for (const row of rows) {
    const fsmName  = cleanName(getTitle(row.properties));
    const quizDates = {};

    for (const [key, prop] of Object.entries(row.properties)) {
      if (prop.type !== 'date') continue;
      quizDates[key] = prop.date ? prop.date.start : null;
      if (prop.date) {
        trackedPairs.push({ fsmName, fp: quizFingerprint(key), date: prop.date.start });
      }
    }
    focusedRows.push({ rowId: row.id, fsmName, quizDates });
  }
  return { trackedPairs, focusedRows };
}

function inTracker(submission, allTrackedPairs) {
  return allTrackedPairs.some(
    (e) => nameMatch(e.fsmName, submission.name) && e.fp === submission.fp
  );
}

// ─── Step 4: Write back missing completion dates ──────────────────────────────

async function patchPage(pageId, properties) {
  return patch(`pages/${pageId}`, { properties });
}

async function writeBackCompletions(toWrite, fsmRows, focusedRows) {
  if (!toWrite.length) { console.log('  Nothing to write back.'); return; }

  let fsmWrites = 0, focusedWrites = 0;

  for (const sub of toWrite) {
    const date = sub.date;
    if (!date || date === '?') continue;

    // ── FSM Completed Quiz Tracker: find row by quiz fp, column by person name ──
    const fsmRow = fsmRows.find((r) => r.fp === sub.fp);
    if (fsmRow) {
      // Find the person column whose name fuzzy-matches the submission name
      const personCol = Object.keys(fsmRow.personDates).find(
        (col) => nameMatch(cleanName(col), sub.name)
      );
      if (personCol && fsmRow.personDates[personCol] === null) {
        if (DRY_RUN) {
          console.log(`  [DRY-RUN] FSM tracker: row "${fsmRow.subject}" col "${personCol}" → ${date}`);
        } else {
          try {
            await patchPage(fsmRow.rowId, { [personCol]: { date: { start: date } } });
            console.log(`  ✓ FSM tracker: "${fsmRow.subject}" | ${personCol} → ${date}`);
            fsmWrites++;
          } catch (e) {
            console.warn(`  ✗ FSM tracker write failed (${personCol}): ${e.message}`);
          }
        }
      }
    }

    // ── Quiz Focused Tracker: find row by person name, column by quiz fp ──
    const focusedRow = focusedRows.find((r) => nameMatch(r.fsmName, sub.name));
    const focusedCol = FP_TO_FOCUSED_COL[sub.fp];
    if (focusedRow && focusedCol && focusedRow.quizDates[focusedCol] === null) {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Focused tracker: "${focusedRow.fsmName}" col "${focusedCol}" → ${date}`);
      } else {
        try {
          await patchPage(focusedRow.rowId, { [focusedCol]: { date: { start: date } } });
          console.log(`  ✓ Focused tracker: "${focusedRow.fsmName}" | ${focusedCol} → ${date}`);
          focusedWrites++;
        } catch (e) {
          console.warn(`  ✗ Focused tracker write failed (${focusedCol}): ${e.message}`);
        }
      }
    }
  }

  if (!DRY_RUN) {
    console.log(`  Wrote ${fsmWrites} FSM tracker cell(s), ${focusedWrites} Focused tracker cell(s).`);
  }
}

// ─── Step 5: Build & print report ────────────────────────────────────────────

function pad(s, n) {
  const str = String(s ?? '');
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function printReport(submissions, allTrackedPairs) {
  const needsGrading  = submissions.filter((s) => !s.teamsMsg);
  const gradedNotSent = submissions.filter((s) => s.teamsMsg && !s.resultsSent);
  const trackerGaps   = submissions.filter((s) => !inTracker(s, allTrackedPairs));

  const unrentableUngraded = needsGrading.filter((s) => norm(s.quizName).includes(UNRENTABLE_KEYWORD));
  const preReviewed  = unrentableUngraded.filter((s) => s.hasFeedback === true);
  const trulyBlank   = unrentableUngraded.filter((s) => s.hasFeedback !== true);
  const otherUngraded = needsGrading.filter((s) => !norm(s.quizName).includes(UNRENTABLE_KEYWORD));

  const SEP  = '─'.repeat(118);
  const HDR  = `   ${pad('Quiz Name', 36)} ${pad('Person', 28)} ${pad('Submitted', 12)} URL`;
  const DIV  = '   ' + '─'.repeat(115);

  const row = (s, tag) => {
    const label = tag ? `${s.name} [${tag}]` : s.name;
    return `   ${pad(s.quizName, 36)} ${pad(label, 28)} ${pad(s.date, 12)} ${s.url}`;
  };

  // ── A ─────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('A) NEEDS GRADING — Teams Message is empty');
  console.log(SEP);

  if (needsGrading.length === 0) {
    console.log('   (none)');
  } else {
    if (otherUngraded.length) {
      console.log('\n   ── Other quizzes ──');
      console.log(HDR); console.log(DIV);
      otherUngraded.forEach((s) => console.log(row(s)));
    }
    if (preReviewed.length) {
      console.log(`\n   ── Unrentable: ALREADY REVIEWED on page — just needs Teams message sent [${preReviewed.length}] ──`);
      console.log(HDR); console.log(DIV);
      preReviewed.forEach((s) => console.log(row(s, 'HAS FEEDBACK')));
    }
    if (trulyBlank.length) {
      console.log(`\n   ── Unrentable: TRULY BLANK — needs grading now [${trulyBlank.length}] ──`);
      console.log(HDR); console.log(DIV);
      trulyBlank.forEach((s) => console.log(row(s, 'BLANK')));
    }
  }

  // ── B ─────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('B) GRADED BUT NOT SENT — Teams Message filled, Results Sent via Teams = false');
  console.log(SEP);
  if (!gradedNotSent.length) {
    console.log('   (none)');
  } else {
    console.log(HDR); console.log(DIV);
    gradedNotSent.forEach((s) => console.log(row(s)));
  }

  // ── C ─────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('C) TRACKER GAPS — fully complete (graded + sent) but not found in either tracker');
  console.log(SEP);
  const completeGaps = trackerGaps.filter((s) => s.teamsMsg && s.resultsSent);
  if (!completeGaps.length) {
    console.log('   (none — all complete submissions are tracked!)');
  } else {
    console.log(HDR); console.log(DIV);
    completeGaps.forEach((s) =>
      console.log(`   ${pad(s.quizName, 36)} ${pad(s.name, 28)} ${pad(s.date, 12)} Missing from tracker`)
    );
  }

  // Also show incomplete-but-untracked as a secondary section
  const incompleteUntracked = trackerGaps.filter((s) => !(s.teamsMsg && s.resultsSent));
  if (incompleteUntracked.length) {
    console.log(`\n   ── Also untracked but incomplete (not yet fully graded/sent) [${incompleteUntracked.length}] ──`);
    console.log(HDR); console.log(DIV);
    incompleteUntracked.forEach((s) =>
      console.log(`   ${pad(s.quizName, 36)} ${pad(s.name, 28)} ${pad(s.date, 12)} Incomplete + untracked`)
    );
  }

  // ── D ─────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP);
  console.log('D) SUMMARY');
  console.log(SEP);

  const byQuiz = {};
  for (const s of submissions) {
    if (!byQuiz[s.quizName]) byQuiz[s.quizName] = { total: 0, complete: 0, gaps: 0 };
    byQuiz[s.quizName].total++;
    if (s.teamsMsg && s.resultsSent && inTracker(s, allTrackedPairs)) byQuiz[s.quizName].complete++;
    if (s.teamsMsg && s.resultsSent && !inTracker(s, allTrackedPairs)) byQuiz[s.quizName].gaps++;
  }

  console.log(`   ${pad('Quiz Name', 50)} ${pad('Total', 7)} ${pad('Fully Complete', 16)} Tracker Gaps`);
  console.log('   ' + '─'.repeat(88));
  let grandTotal = 0, grandComplete = 0, grandGaps = 0;
  for (const [quiz, { total, complete, gaps }] of Object.entries(byQuiz).sort()) {
    console.log(`   ${pad(quiz, 50)} ${pad(total, 7)} ${pad(complete, 16)} ${gaps}`);
    grandTotal    += total;
    grandComplete += complete;
    grandGaps     += gaps;
  }
  console.log('   ' + '─'.repeat(88));
  console.log(`   ${pad('TOTAL', 50)} ${pad(grandTotal, 7)} ${pad(grandComplete, 16)} ${grandGaps}`);
  console.log('\n   "Fully Complete" = Teams Message ✓ + Results Sent ✓ + in tracker ✓');
  console.log(  '   "Tracker Gaps"  = graded + sent but date missing from both trackers\n');

  // ── E: Unrentable deep-dive ───────────────────────────────────────────────
  if (unrentableUngraded.length > 0) {
    console.log(SEP);
    console.log('E) UNRENTABLE DEEP-DIVE');
    console.log(SEP);
    console.log(`   Total ungraded: ${unrentableUngraded.length}  |  Already reviewed (has feedback): ${preReviewed.length}  |  Truly blank: ${trulyBlank.length}`);
    if (preReviewed.length) {
      console.log('\n   Pre-reviewed — write Teams message to close out:');
      preReviewed.forEach((s) =>
        console.log(`     ${pad(s.name, 30)} submitted ${s.date}  ${s.url}`)
      );
    }
    if (trulyBlank.length) {
      console.log('\n   Truly blank — need fresh grading:');
      trulyBlank.forEach((s) =>
        console.log(`     ${pad(s.name, 30)} submitted ${s.date}  ${s.url}`)
      );
    }
    console.log('');
  }

  return completeGaps; // returned so main can write them back
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log('='.repeat(60));
    console.log('Notion Quiz Reconciliation Report');
    console.log(`Run date: ${new Date().toISOString()}`);
    if (DRY_RUN) console.log('MODE: --dry-run (no writes will occur)');
    console.log('='.repeat(60));

    const quizzes     = await discoverQuizzes();
    const submissions = await scanResponses(quizzes);

    await enrichUnrentableFeedback(submissions);

    console.log('\nStep 3 — Reading trackers…');
    const { trackedPairs: fsmPairs,     fsmRows     } = await readFSMTracker();
    const { trackedPairs: focusedPairs, focusedRows } = await readFocusedTracker();
    const allTrackedPairs = [...fsmPairs, ...focusedPairs];
    console.log(`  Total tracked person+quiz pairs with completion dates: ${allTrackedPairs.length}`);

    console.log('\nStep 4 — Building report…');
    const completeGaps = printReport(submissions, allTrackedPairs);

    // ── Step 5: Write back ────────────────────────────────────────────────
    if (completeGaps.length > 0) {
      console.log('='.repeat(60));
      console.log(`Step 5 — Writing ${completeGaps.length} missing completion date(s) back to trackers…`);
      if (DRY_RUN) console.log('(--dry-run: showing what would be written)');
      console.log('='.repeat(60));
      await writeBackCompletions(completeGaps, fsmRows, focusedRows);
    } else {
      console.log('Step 5 — No write-backs needed (no fully-complete tracker gaps).');
    }

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  }
})();
