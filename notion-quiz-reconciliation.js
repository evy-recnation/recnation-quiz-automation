#!/usr/bin/env node
/**
 * notion-quiz-reconciliation.js
 *
 * Discovers all active quizzes from the Answer Keys database, scans every
 * response database for submissions, cross-references both trackers, and
 * prints a four-section reconciliation report.
 *
 * Usage:
 *   NOTION_TOKEN=secret_... node notion-quiz-reconciliation.js
 */

'use strict';

const https = require('https');

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error('ERROR: Set NOTION_TOKEN environment variable before running.');
  process.exit(1);
}

const ANSWER_KEYS_DB   = '3338e709-96c7-809a-9e6f-fc9d18bf14b7';
const FSM_TRACKER_DB   = '41f5edc5-8ddd-4522-9057-70f445e9f3fb';
const FOCUSED_TRACKER_DB = 'e308e709-96c7-838e-a50b-8194b02e9a40';

// Name property candidates (tried in order)
const NAME_PROPS = [
  'Name',
  'First & Last Name',
  'First and Last Name: ',
  'Q1 First Last Name',
];

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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** GET /v1/<path> */
const get = (path) => request('GET', `/v1/${path}`, null);

/** POST /v1/<path> with body */
const post = (path, body) => request('POST', `/v1/${path}`, body);

// ─── Pagination helpers ───────────────────────────────────────────────────────

/** Paginate through all blocks for a page */
async function getAllBlocks(pageId) {
  const blocks = [];
  let cursor = undefined;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : '';
    const res = await get(`blocks/${pageId}/children${params}`);
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

/** Paginate through all rows of a database */
async function getAllRows(dbId, filter) {
  const rows = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    const res = await post(`databases/${dbId}/query`, body);
    rows.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// ─── Property extractors ──────────────────────────────────────────────────────

function getTitle(props) {
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p.type === 'title' && p.title && p.title.length > 0) {
      return p.title.map((t) => t.plain_text).join('').trim();
    }
  }
  return '';
}

function getPersonName(props) {
  for (const candidate of NAME_PROPS) {
    const p = props[candidate];
    if (!p) continue;
    if (p.type === 'title' && p.title && p.title.length > 0) {
      return p.title.map((t) => t.plain_text).join('').trim();
    }
    if (p.type === 'rich_text' && p.rich_text && p.rich_text.length > 0) {
      return p.rich_text.map((t) => t.plain_text).join('').trim();
    }
  }
  return '(unknown)';
}

function getDate(props) {
  // Try "Submission Date", "Date", "Created", or fall back to created_time
  for (const key of ['Submission Date', 'Date', 'Created Time', 'Created']) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'date' && p.date) return p.date.start;
    if (p.type === 'created_time') return p.created_time;
  }
  return null;
}

function isTeamsMessageFilled(props) {
  const p = props['Teams Message'];
  if (!p) return false;
  if (p.type === 'rich_text') return p.rich_text && p.rich_text.length > 0;
  if (p.type === 'url')       return !!p.url;
  if (p.type === 'email')     return !!p.email;
  return false;
}

function isResultsSentViaTeams(props) {
  const p = props['Results Sent via Teams'];
  if (!p) return false;
  if (p.type === 'checkbox') return p.checkbox === true;
  return false;
}

function pageUrl(pageId) {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

// ─── Step 1: Discover all quizzes ────────────────────────────────────────────

async function discoverQuizzes() {
  console.log('Step 1 — Querying Answer Keys database…');
  const rows = await getAllRows(ANSWER_KEYS_DB);
  console.log(`  Found ${rows.length} answer key row(s).`);

  const quizzes = [];
  for (const row of rows) {
    const quizName = getTitle(row.properties);
    const pageId   = row.id;
    // Find the child_database block inside this answer key page
    let responseDatabaseId = null;
    try {
      const blocks = await getAllBlocks(pageId);
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
  const submissions = []; // { quizName, name, date, teamsMsg, resultsSent, url }

  for (const { quizName, responseDatabaseId } of quizzes) {
    if (!responseDatabaseId) {
      console.log(`  [SKIP] "${quizName}" — no child_database found`);
      continue;
    }
    let rows;
    try {
      rows = await getAllRows(responseDatabaseId);
    } catch (e) {
      console.warn(`  Warning: could not query response DB for "${quizName}": ${e.message}`);
      continue;
    }
    console.log(`  "${quizName}": ${rows.length} submission(s)`);
    for (const row of rows) {
      const name        = getPersonName(row.properties);
      const date        = getDate(row.properties) || row.created_time?.slice(0, 10) || '?';
      const teamsMsg    = isTeamsMessageFilled(row.properties);
      const resultsSent = isResultsSentViaTeams(row.properties);
      const url         = pageUrl(row.id);
      submissions.push({ quizName, name, date, teamsMsg, resultsSent, url });
    }
  }
  return submissions;
}

// ─── Step 3: Query trackers ───────────────────────────────────────────────────

/**
 * Returns a Set of "<normalized-name>|<normalized-quiz>" strings
 * representing entries that have a non-empty completion date.
 */
async function queryTracker(dbId, label) {
  console.log(`  Querying ${label}…`);
  let rows;
  try {
    rows = await getAllRows(dbId);
  } catch (e) {
    console.warn(`  Warning: could not query ${label}: ${e.message}`);
    return new Set();
  }
  console.log(`    ${rows.length} row(s)`);

  const entries = new Set();
  for (const row of rows) {
    const props = row.properties;

    // Grab the FSM/person name
    let fsm = getTitle(props);
    if (!fsm) fsm = getPersonName(props);

    // Grab quiz name — could be a relation, select, title, or rich_text
    let quiz = '';
    for (const key of ['Quiz', 'Quiz Name', 'Topic', 'Knowledge Article']) {
      const p = props[key];
      if (!p) continue;
      if (p.type === 'select' && p.select) { quiz = p.select.name; break; }
      if (p.type === 'title' && p.title && p.title.length > 0) {
        quiz = p.title.map((t) => t.plain_text).join('').trim(); break;
      }
      if (p.type === 'rich_text' && p.rich_text && p.rich_text.length > 0) {
        quiz = p.rich_text.map((t) => t.plain_text).join('').trim(); break;
      }
      if (p.type === 'relation' && p.relation && p.relation.length > 0) {
        // Just mark as having some relation; we'll match by FSM only when quiz unknown
        quiz = p.relation.map((r) => r.id).join(','); break;
      }
    }

    // Completion date — any Date property or "Completion Date"
    let hasDate = false;
    for (const key of Object.keys(props)) {
      const p = props[key];
      if (p.type === 'date' && p.date) { hasDate = true; break; }
    }

    if (hasDate) {
      entries.add(`${norm(fsm)}|${norm(quiz)}`);
    }
  }
  return entries;
}

function norm(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── Step 4: Build & print report ────────────────────────────────────────────

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function printReport(submissions, trackerEntries) {
  const needsGrading     = submissions.filter((s) => !s.teamsMsg);
  const gradedNotSent    = submissions.filter((s) => s.teamsMsg && !s.resultsSent);
  const trackerGaps      = submissions.filter((s) => {
    // Check if this submission appears in either tracker
    const key = `${norm(s.name)}|${norm(s.quizName)}`;
    return !trackerEntries.has(key);
  });

  const line = '─'.repeat(110);

  // ── A ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('A) NEEDS GRADING — Teams Message is empty');
  console.log(line);
  if (needsGrading.length === 0) {
    console.log('   (none)');
  } else {
    console.log(`   ${pad('Quiz Name', 35)} ${pad('Person Name', 28)} ${pad('Submitted', 12)} URL`);
    console.log('   ' + '─'.repeat(107));
    for (const s of needsGrading) {
      console.log(`   ${pad(s.quizName, 35)} ${pad(s.name, 28)} ${pad(s.date, 12)} ${s.url}`);
    }
  }

  // ── B ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('B) GRADED BUT NOT SENT — Teams Message filled, Results Sent via Teams = false');
  console.log(line);
  if (gradedNotSent.length === 0) {
    console.log('   (none)');
  } else {
    console.log(`   ${pad('Quiz Name', 35)} ${pad('Person Name', 28)} ${pad('Submitted', 12)} URL`);
    console.log('   ' + '─'.repeat(107));
    for (const s of gradedNotSent) {
      console.log(`   ${pad(s.quizName, 35)} ${pad(s.name, 28)} ${pad(s.date, 12)} ${s.url}`);
    }
  }

  // ── C ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('C) TRACKER GAPS — submission exists but missing from FSM Completed Quiz Tracker');
  console.log(line);
  if (trackerGaps.length === 0) {
    console.log('   (none)');
  } else {
    console.log(`   ${pad('Quiz Name', 35)} ${pad('Person Name', 28)} ${pad('Submitted', 12)} Note`);
    console.log('   ' + '─'.repeat(107));
    for (const s of trackerGaps) {
      console.log(`   ${pad(s.quizName, 35)} ${pad(s.name, 28)} ${pad(s.date, 12)} Missing from tracker`);
    }
  }

  // ── D ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('D) SUMMARY');
  console.log(line);

  const byQuiz = {};
  for (const s of submissions) {
    if (!byQuiz[s.quizName]) byQuiz[s.quizName] = { total: 0, complete: 0 };
    byQuiz[s.quizName].total++;
    const inTracker = trackerEntries.has(`${norm(s.name)}|${norm(s.quizName)}`);
    if (s.teamsMsg && s.resultsSent && inTracker) byQuiz[s.quizName].complete++;
  }

  console.log(`   ${pad('Quiz Name', 40)} ${pad('Total Submissions', 20)} Fully Complete`);
  console.log('   ' + '─'.repeat(80));
  let grandTotal = 0, grandComplete = 0;
  for (const [quiz, { total, complete }] of Object.entries(byQuiz).sort()) {
    console.log(`   ${pad(quiz, 40)} ${pad(total, 20)} ${complete}`);
    grandTotal   += total;
    grandComplete += complete;
  }
  console.log('   ' + '─'.repeat(80));
  console.log(`   ${pad('TOTAL', 40)} ${pad(grandTotal, 20)} ${grandComplete}`);
  console.log('\n   "Fully Complete" = graded + Results Sent via Teams + in tracker\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log('='.repeat(60));
    console.log('Notion Quiz Reconciliation Report');
    console.log(`Run date: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const quizzes     = await discoverQuizzes();
    const submissions = await scanResponses(quizzes);

    console.log(`\nStep 3 — Querying trackers…`);
    const [fsmEntries, focusedEntries] = await Promise.all([
      queryTracker(FSM_TRACKER_DB,     'FSM Completed Quiz Tracker'),
      queryTracker(FOCUSED_TRACKER_DB, 'Quiz Focused Tracker'),
    ]);
    // Merge both tracker sets
    const allTrackerEntries = new Set([...fsmEntries, ...focusedEntries]);
    console.log(`  Combined tracker entries with completion dates: ${allTrackerEntries.size}`);

    console.log('\nStep 4 — Building report…');
    printReport(submissions, allTrackerEntries);

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  }
})();
