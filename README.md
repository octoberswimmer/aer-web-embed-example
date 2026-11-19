# Embedding the aer js/wasm runtime in a web page

aer is built for the browser as well as for the command line. The browser build is a
WebAssembly (wasm) binary that runs in a Web Worker and executes Apex in the visitor's
browser tab, against an in-memory org with the standard objects. No Salesforce org is
needed, nothing is installed, and the code is never sent to a server.

The [Apex playground](https://aertest.com/play/) on aertest.com works this way, and
this repository is a sample exercise page built the same way. Any site can do the same
with static hosting. This document describes the sample, the steps to build your own
page, the request and response formats, and three ways to check a learner's solution:
anonymous Apex with appended assertions, classes and triggers with assertions, and test
classes.

Use the latest stable aer release, currently **v1.6.18**. Everything below was verified
against v1.6.18 in Chrome and in Node on 2026-11-19.

## The sample application

The sample page has three exercises, one for each way of checking a solution:

| Exercise | Learner writes | How the page checks it |
| --- | --- | --- |
| 1. Anonymous Apex | Anonymous Apex that inserts three Accounts | Assertions appended to the learner's code, run through `aerExec` |
| 2. Write tests | A test class for a provided `Discount` class | `aerRunTests` runs the learner's tests against `Discount`, where they must pass, then against a broken copy, where at least one must fail |
| 3. Trigger on Account | A `before insert` trigger on Account | Anonymous Apex that inserts Accounts and checks the trigger's changes, run through `aerExec` with the trigger in `sourcePaths` |

The sample is two files:

- [`index.html`](index.html): the page. All of its JavaScript is in one script at the
  bottom. The exercises are the `EXERCISES` array; each has a task, starter code, a
  reference solution, and its checks. `buildSteps` turns an exercise and the learner's
  code into the worker messages that check it, and `judgeStep` turns each response
  into pass or fail.
- [`aer-worker.js`](aer-worker.js): the Web Worker that downloads and runs the runtime.
  Copy it as it is.

Below the results, the page keeps a runtime log. It lists the startup stages with the
time since the page loaded: the runtime download, with its size and how long it
took (about 0.1 s when the browser's cache has it), unpacking, starting the wasm VM, the
aer version, and whether `/tmp` is on OPFS. It then lists each warm-up and run with its
duration and result, and every line the runtime prints, unfiltered. The output under
the editor shows only what concerns the learner's code.

To start your own page, copy both files to your site, set `WORKER_URL` in the page to
where you serve the worker (it is relative to the page), and replace the exercises.

### Running the sample

Serve this directory with any static file server:

```
npm start      # python3 -m http.server 8000 --bind 127.0.0.1
```

Then open http://127.0.0.1:8000/ or http://localhost:8000/. Use one of those addresses,
not `http://0.0.0.0:8000/`: browsers give OPFS only to secure contexts (HTTPS,
`localhost`, and `127.0.0.1`), and at any other plain-HTTP address the runtime log
reports "OPFS is not available" and the runtime keeps its databases in memory. The first visit downloads the runtime from
`aer-web.octoberswimmer.com`, which allows cross-origin requests.

### Testing the sample

```
npm test
```

The tests check the page's markup hooks, the worker's message handling and OPFS mount,
the request each exercise builds, and how responses become pass or fail. When the `aer`
CLI is on `PATH`, they also run every exercise's solution (which must pass its checks)
and starter code (which must fail) through it. Run them after changing an exercise or
the runtime version.

## How the pieces fit

```
your page ──postMessage──▶ aer-worker.js (Web Worker, served from your site)
                              │
                              ├─ downloads aer_web_wasm_<version>.zip
                              │  from aer-web.octoberswimmer.com
                              ├─ unpacks aer.wasm + wasm_exec.js and starts the Go runtime
                              ├─ keeps an in-memory file system for your Apex source
                              ├─ mounts /tmp on the browser's origin private file system
                              │  (OPFS), where the runtime builds its databases
                              ├─ saves /cache (the org template) to IndexedDB between visits
                              └─ calls aerExec (anonymous Apex) or aerRunTests (test classes)
your page ◀──postMessage── progress, debug and log lines, results
```

### Where the worker stores data

| Path | Stored in | Contents |
| --- | --- | --- |
| `/workspace/...` | Worker memory | The source files your page sends. |
| `/tmp` | OPFS | The SQLite databases the runtime builds for each run: the org template and one copy per test. |
| `/cache` | Worker memory, saved to IndexedDB | aer's cache, including the org template, so the next visit skips building it. |

The OPFS mount is what lets a large project run. Without it, the databases are held in
wasm memory, which is limited to 4 GiB, and a project with hundreds of classes runs out.
The worker sets the `AER_WASM_OPFS_DIR` environment variable only when the mount
succeeds; the runtime then builds its databases there and prints
`aer: building test databases on disk in /tmp/aer-spill-...`. When OPFS is not
available, the worker leaves the variable unset and the runtime keeps its databases in
memory, which is enough for exercise-sized code.

Each worker uses its own directory under `aer-tmp/` in the origin's OPFS and holds a
lock file open while it runs. A worker that starts later deletes the directories of
workers that have exited, so OPFS does not fill up across visits.

The OPFS code is a port of the mount in aer's VS Code web extension.

## Requirements

| Item | Detail |
| --- | --- |
| Hosting | Static files only, over HTTPS (or from `localhost` during development). The worker script must be served from the same origin as the page, because browsers only start Web Workers from same-origin scripts. OPFS is only available in secure contexts; on plain HTTP the runtime falls back to memory. |
| Download | 54 MB zip for v1.6.18, on the first visit. The release server sends `Access-Control-Allow-Origin: *`, `ETag`, and `Last-Modified`, and answers a request carrying the `ETag` with `304 Not Modified`. Later visits load the zip from the browser's HTTP cache: in Chrome the second load took 80 ms and sent no request. |
| Memory | `aer.wasm` is 339 MB uncompressed. Desktop browsers handle it. Phones and tablets have not been tested. |
| Browser features | WebAssembly, Web Workers, and `DecompressionStream('deflate-raw')`: Chrome and Edge 103+, Firefox 113+, Safari 16.4+. OPFS sync access handles are in the same versions. |
| HTTP headers | None. The runtime does not use `SharedArrayBuffer`, so the page does not need `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`. |

## Step 1: Copy the worker

Copy [`aer-worker.js`](aer-worker.js) from this repository and serve it from your
site. The worker accepts these messages:

| Message | Fields | What it does |
| --- | --- | --- |
| `init` | `zipUrl`, `cwd` | Downloads the runtime, mounts OPFS, and starts the runtime. `cwd` is the working directory in the virtual file system. |
| `run` | `id`, `request`, `files` | Writes `files`, then runs anonymous Apex through `aerExec`. |
| `test` | `id`, `request`, `files` | Writes `files`, then runs `@IsTest` methods through `aerRunTests`. |

`files` is a list of `{ path, content }`. A `content` of `null` deletes the file.

And sends these:

| `type` | Fields | When |
| --- | --- | --- |
| `progress` | `stage`, `detail` | While the zip downloads (`detail` includes MB received), unpacks, and starts. |
| `ready` | `version`, `opfs` | The runtime accepts requests. `opfs` is `{ mounted: true, path: '/tmp', handles: 64 }` or `{ mounted: false, reason: '...' }`. |
| `stdout` | `line` | The runtime's console output. Test runs print `System.debug` output and caught exceptions here when asked to (see Step 4). Lines starting with `[memory/wasm]` report large memory allocations and can be ignored. |
| `debug` | `id`, `line` | One `System.debug` line from the `run` with that `id`, sent while it runs. |
| `result` | `id`, `response` | The `run` with that `id` finished. |
| `test-result` | `id`, `test` | One test method of the `test` with that `id` finished. |
| `test-done` | `id`, `response` | The `test` with that `id` finished. |
| `error` | `message` | The runtime failed to download or start. |

## Step 2: Choose a runtime release

The runtime zip URL has this form:

```
https://aer-web.octoberswimmer.com/releases/download/<version>/aer_web_wasm_<version>.zip
```

Use v1.6.18, the latest stable release. The list of releases is at
[github.com/octoberswimmer/aer-dist/releases](https://github.com/octoberswimmer/aer-dist/releases).
Pin the version in your page rather than following the newest release, so that a new aer
release cannot change how your exercises behave until you update the version and check
them.

## Step 3: Start the worker and run anonymous Apex

```js
var AER_VERSION = 'v1.6.18';
var ZIP_URL = 'https://aer-web.octoberswimmer.com/releases/download/' +
	AER_VERSION + '/aer_web_wasm_' + AER_VERSION + '.zip';

var worker = new Worker('/aer-worker.js');
worker.postMessage({ type: 'init', zipUrl: ZIP_URL, cwd: '/workspace/exercises' });

var runId = 0;
function run(code) {
	worker.postMessage({
		type: 'run',
		id: ++runId,
		request: {
			code: code,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
			enforceGovernorLimits: true
		}
	});
}

worker.onmessage = function (event) {
	var m = event.data;
	if (m.type === 'ready') {
		// Enable the Run button.
	} else if (m.type === 'debug' && m.id === runId) {
		// Show m.line.
	} else if (m.type === 'result' && m.id === runId) {
		var r = m.response;
		if (r.error) {
			// The request could not run: r.error
		} else if (!r.compiled) {
			// Compile error: r.compileProblem
		} else if (!r.success) {
			// Uncaught exception: r.exceptionMessage, r.exceptionStackTrace
		} else {
			// Success
		}
	}
};
```

### Request fields (`aerExec`)

| Field | Type | Meaning |
| --- | --- | --- |
| `code` | string | The anonymous Apex to run. Classes declared inside it work. Required. |
| `sourcePaths` | string[] | Directories in the worker's file system that hold classes, triggers, and object metadata, laid out as in an SFDX project. |
| `timezone` | string | IANA time zone for the running user, for example `America/New_York`. Defaults to UTC. |
| `enforceGovernorLimits` | boolean | Throw `System.LimitException` when a governor limit is exceeded, as Salesforce does. Off unless set. |
| `allowCallouts` | boolean | Let HTTP callouts go out through the browser's `fetch`. The target must allow cross-origin requests. Off unless set. |
| `apiVersion` | string | API version the anonymous block and its inline classes declare, for example `"62.0"`. |
| `heapLimit` | string | Maximum Apex heap size. |
| `sandbox` | boolean | Report the org as a sandbox (`Organization.IsSandbox`). |
| `allExceptions` | boolean | Print every caught exception, with the class, method, and line that caught it, as `stdout` lines. The same as `aer test --all-exceptions`. Releases after v1.6.18. |

### Response fields

| Field | Meaning |
| --- | --- |
| `compiled` | `false` when the code did not parse or type-check; `compileProblem` then holds the message, for example `<anonymous>:1:12 Unexpected token ';'.` |
| `success` | `true` when the block ran to the end without an uncaught exception. |
| `exceptionMessage` | The uncaught exception, for example `System.AssertException: Assertion Failed: Expected 3 Accounts: Expected: 3, Actual: 2`. |
| `exceptionStackTrace` | For example `AnonymousBlock: line 8, column 1`. |
| `line`, `column` | Where the exception was thrown; `-1` when unknown. |
| `logs` | All `System.debug` lines from the run, joined with newlines. The same lines also arrive one at a time as `debug` messages. |
| `error` | The request could not run at all, for example `another anonymous Apex execution is in progress`. |

### Behavior to plan for

- **Each run starts with an empty database** containing only the standard objects'
  setup data. Records inserted in one run are gone in the next.
- **One request at a time.** A second request sent while one is running gets
  `another anonymous Apex execution is in progress`. Disable the Run button until the
  result arrives.
- **The first run takes longest**, because it builds the org template, and the first
  test run builds the test runner's copy of it. The sample page enables Run as soon as
  `ready` arrives and runs both warm-ups in the background, one step of an exercise's
  own solution each. A Run click during a warm-up waits for it and then starts, so
  the learner never waits longer than the remaining warm-up time.
- **Queueables and other async Apex** run after the anonymous block commits, within the
  same request.

Measured times for v1.6.18 in headless Chrome 157 on a Linux desktop, running the sample
page with the zip served from the same machine (on a first visit, add the time to
download 54 MB over the visitor's connection):

| Step | First visit | Later visit |
| --- | --- | --- |
| Page load until Run is enabled (unpack and start the runtime) | 5.5 s | 2.1 s |
| Run clicked as soon as it is enabled (waits for the anonymous warm-up) | 18 s | 10 s |
| Anonymous Apex run after the warm-up (exercises 1 and 3) | 1.2 to 1.8 s | |
| Test-writing check after both warm-ups (exercise 2: two test runs) | 4.3 s | |
| Test run without the test-runner warm-up | 11 s | |

A later visit starts faster because the zip comes from the HTTP cache and part of
aer's cache comes from IndexedDB. The worker saves `/cache` to IndexedDB in the
background after each run; a page closed before that finishes saves only part of it.

## Step 4: Check a learner's solution

All three approaches below return pass or fail, the failure message, and the line. The
checks run in the learner's browser, so a learner who opens the browser's developer
tools can read the checks and change the result. That is acceptable for practice
exercises, not for graded certification.

### A. Anonymous Apex: append the checks to the learner's code

Send the learner's code followed by your assertions as one block:

```js
var CHECKS = [
	"List<Account> aerCheckAccounts = [SELECT Name FROM Account ORDER BY Name];",
	"Assert.areEqual(3, aerCheckAccounts.size(), 'Insert exactly three Accounts');"
].join('\n');

worker.postMessage({
	type: 'run',
	id: ++runId,
	request: { code: learnerCode + '\n' + CHECKS, timezone: 'UTC', enforceGovernorLimits: true }
});
```

Read the result by comparing the exception's line with the number of lines the learner
wrote:

| Response | Meaning for the learner |
| --- | --- |
| `compiled: false` | Their code has a syntax or type error. Show `compileProblem`. |
| `success: false`, `line` ≤ the learner's line count | Their code threw an exception. Show `exceptionMessage`. |
| `success: false`, `line` > the learner's line count | Their code ran but a check failed. Show the assertion message. |
| `success: true` | Every check passed. |

For example, a learner who inserts 2 Accounts instead of 3 gets
`System.AssertException: Assertion Failed: Insert exactly three Accounts: Expected: 3, Actual: 2`
and their own `System.debug` output in `logs`.

Write each assertion with a message that tells the learner what was expected. Because
both pieces run in the same block, give the checks' variables names a learner will not
use, such as the `aerCheck` prefix above.

### B. Classes and triggers: write them as files, check with anonymous Apex

Send the learner's class or trigger in `files` and run your checks as anonymous Apex
with `sourcePaths` pointing at the directory. The response has the same fields as in A,
including `System.debug` output from the learner's code. Exercise 3 of the sample works
this way:

```js
var DIR = '/workspace/exercises/account-trigger/force-app';
var CHECKS = [
	"Account aerCheckBlank = new Account(Name = 'Blank');",
	"insert aerCheckBlank;",
	"Assert.areEqual('New customer', [SELECT Description FROM Account WHERE Id = :aerCheckBlank.Id].Description, 'A blank Description should become New customer');"
].join('\n');

worker.postMessage({
	type: 'run',
	id: ++runId,
	files: [{ path: DIR + '/main/default/triggers/AccountTrigger.trigger', content: learnerTrigger }],
	request: { code: CHECKS, sourcePaths: [DIR], timezone: 'UTC', enforceGovernorLimits: true }
});
```

Every assertion failure is a failed check, since none of the anonymous code is the
learner's. An exception from the learner's trigger shows in `exceptionMessage` and
`exceptionStackTrace` like any other.

- `-meta.xml` files are not required for classes and triggers.
- Use one directory per exercise, so that files from one exercise do not compile into
  another.
- Object and field metadata in the same directory (`objects/Invoice__c/...`) is read the
  same way the `aer` command line reads it, so exercises can use custom objects.

### C. Test classes: run `@IsTest` methods

Send a `test` message to run `@IsTest` methods. The test classes can be your checks, or
the learner's own tests when the exercise is to write tests. Exercise 2 of the sample
asks for tests of a provided `Discount` class and runs them twice. First against
`Discount`, where every test must pass:

```js
var DIR = '/workspace/exercises/discount-tests/force-app';

worker.postMessage({
	type: 'test',
	id: ++runId,
	files: [
		{ path: DIR + '/main/default/classes/Discount.cls', content: discountSource },
		{ path: DIR + '/main/default/classes/DiscountTest.cls', content: learnerTests }
	],
	request: { sourcePaths: [DIR], timezone: 'UTC', verbose: true }
});
```

Then against a broken copy of `Discount` that returns the discount instead of the
discounted amount, where at least one test must fail. Tests that pass against both
copies assert nothing that matters.

```js
worker.postMessage({
	type: 'test',
	id: ++runId,
	files: [{ path: DIR + '/main/default/classes/Discount.cls', content: brokenDiscountSource }],
	request: { sourcePaths: [DIR], timezone: 'UTC', verbose: true }
});
```

The worker sends one `test-result` per test method as it finishes, then `test-done` with
the full response. The response of the second run for the sample's reference tests:

```json
{
	"tests": [
		{
			"testName": "DiscountTest.applies_the_percentage",
			"className": "DiscountTest",
			"methodName": "applies_the_percentage",
			"passed": false,
			"durationMs": 106,
			"errorMessage": "System.AssertException: DiscountTest.cls:5: Assertion Failed: apply(100, 10): Expected: 90, Actual: 10\nClass.DiscountTest.applies_the_percentage: line 5, column 1 (DiscountTest.cls)",
			"file": "/workspace/exercises/discount-tests/force-app/main/default/classes/DiscountTest.cls",
			"line": 5,
			"column": 1
		},
		{
			"testName": "DiscountTest.rejects_a_percentage_over_100",
			"className": "DiscountTest",
			"methodName": "rejects_a_percentage_over_100",
			"passed": true,
			"durationMs": 1
		}
	],
	"total": 2,
	"passed": 1,
	"failed": 1,
	"error": "1 test failed"
}
```

Failed tests also carry `fileUri`, the `file` path as a `file://` URI.

Test request fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `sourcePaths` | string[] | Directories holding the code and the test classes. Required. |
| `filters` | string[] | Run only these tests, for example `["DiscountTest.applies_the_percentage"]`. |
| `timezone`, `locale`, `currency` | string | The running user's settings. |
| `sandbox` | boolean | Report the org as a sandbox. |
| `verbose` | boolean | Print `System.debug` output from the test methods as `stdout` lines. The same as `aer test --verbose`. Releases after v1.6.18; v1.6.18 ignores it and prints no debug output from tests. |
| `allExceptions` | boolean | Print every caught exception as `stdout` lines. The same as `aer test --all-exceptions`. Releases after v1.6.18. |

- Treat `total: 0` as a failure. It means no test method ran, usually because the code
  does not compile; `error` then holds the compile error, followed by a `Tip:` paragraph
  about command-line flags that you can drop.
- `stdout` lines carry no `id`. Show them while a test request is running and treat them
  as belonging to it, since only one request runs at a time. The sample hides them
  during the run against the broken copy, where failures are expected.
- A failed test's `errorMessage` has the assertion message on its first line and the
  stack trace after it.

## Licensing and attribution

The aer license (`LICENSE` in the runtime zip) allows free use of the language server,
the test runner for up to 100 tests at a time, and the debugger for up to five minutes
per session. Embedding aer in a public website is outside those free uses. To license aer
for your site, contact [sales@octoberswimmer.com](mailto:sales@octoberswimmer.com).

On each page that runs aer, include a visible credit such as "Powered by aer" linking to
[aertest.com](https://aertest.com). The runtime zip also contains
`third-party-licenses.txt`, the licenses of the open-source libraries compiled into aer;
link to a copy of it from your site.
