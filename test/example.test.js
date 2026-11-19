'use strict';

// Tests for the sample exercise page. Run with: npm test
// The page checks Apex exercises through the aer js/wasm build in a Web
// Worker; these tests guard the markup hooks, the worker contract, the
// page's pure helpers, and that every exercise's solution passes its checks
// under the native aer CLI while its starter code does not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(rootDir, 'aer-worker.js'), 'utf8');

// Runs the page's own script against a stub sandbox (no Worker, no document)
// so the pure helpers are exercised, not just their markup.
function loadHelpers() {
	const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
	const sandbox = { window: {} };
	vm.runInNewContext(script, sandbox);
	assert.ok(sandbox.window.__exampleTest, 'page should expose its testable helpers');
	return sandbox.window.__exampleTest;
}

// Copies a value made inside the page's vm context, whose arrays and objects
// have that context's prototypes, so deepEqual compares only the contents.
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function hasAer() {
	return spawnSync('aer', ['--help'], { encoding: 'utf8' }).status === 0;
}

test('uses tabs for indentation', () => {
	for (const [name, text] of [['index.html', html], ['aer-worker.js', worker]]) {
		const offending = text.split('\n').filter((line) => /^ {2,}/.test(line));
		assert.deepEqual(offending, [], `${name} should be tab-indented`);
	}
});

test('does not set COEP', () => {
	assert.ok(!html.includes('Cross-Origin-Embedder-Policy'), 'COEP must not be introduced');
});

test('wires up the hooks the script expects', () => {
	for (const id of ['exerciseTabs', 'exerciseTitle', 'exerciseTask', 'exerciseProvided', 'exerciseProvidedFile', 'exerciseProvidedSource', 'exerciseFile', 'codeInput', 'runBtn', 'resetBtn', 'allExceptions', 'status', 'verdict', 'checks', 'outputBlock', 'output', 'runtimeLog', 'runtimeLogCount', 'runtimeLogText', 'clearLogBtn', 'showMemoryLines']) {
		assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
	}
	assert.ok(html.includes('Powered by <a href="https://aertest.com">aer</a>'), 'page should credit aer');
});

test('starts its own worker and pins the latest stable release', () => {
	assert.ok(html.includes("var WORKER_URL = 'aer-worker.js';"), 'page should start the worker served next to it');
	assert.ok(html.includes("var AER_VERSION = 'v1.6.19';"), 'page should pin aer v1.6.19');
	const { runtimeZipUrl } = loadHelpers();
	const url = (v) => `https://aer-web.octoberswimmer.com/releases/download/${v}/aer_web_wasm_${v}.zip`;
	assert.equal(runtimeZipUrl(''), url('v1.6.19'));
	assert.equal(runtimeZipUrl('?version=v1.7.5'), url('v1.7.5'));
	assert.equal(runtimeZipUrl('?version=..%2Fevil'), url('v1.6.19'), 'anything but a release tag falls back to the pin');
	assert.equal(runtimeZipUrl('?wasmZip=%2Flocal.zip'), '/local.zip', 'a same-origin zip wins');
});

test('worker runs anonymous Apex and tests with files sent per request', () => {
	assert.doesNotThrow(() => new Function(worker), 'worker should parse');
	assert.ok(worker.includes('self.aerExec(JSON.stringify(message.request))'), 'run should call aerExec');
	assert.ok(worker.includes('self.aerRunTests(JSON.stringify(message.request))'), 'test should call aerRunTests');
	assert.ok(worker.includes("type: 'test-result'") && worker.includes("type: 'test-done'"), 'test results should stream, then finish');
	assert.ok(worker.includes('writeFiles(message.files);'), 'files should be written before each request runs');
});

test('worker mounts /tmp on OPFS and tells the runtime', () => {
	assert.ok(worker.includes("var OPFS_MOUNT_PATH = '/tmp';"), 'the mount should cover /tmp');
	assert.ok(worker.includes("var OPFS_ENV_VAR = 'AER_WASM_OPFS_DIR';"), 'the runtime reads AER_WASM_OPFS_DIR');
	assert.ok(worker.includes('createSyncAccessHandle()'), 'files on the mount use sync access handles');
	assert.ok(worker.includes('go.env = Object.assign({}, go.env || {}, runtimeEnv());'), 'the runtime environment should name the mount');
	assert.ok(worker.includes('var mountReady = initOpfsMount();'), 'the mount should be settled before the runtime starts');
	assert.ok(worker.includes("type: 'ready', version: version, opfs: opfsStatus()"), 'ready should report the mount');
});

test('ships one exercise per way of checking a solution', () => {
	const { EXERCISES } = loadHelpers();
	assert.deepEqual(plain(EXERCISES.map((e) => e.kind)), ['anonymous', 'tests', 'source']);
	const trigger = EXERCISES.find((e) => e.kind === 'source');
	assert.match(trigger.file, /^triggers\/\w+\.trigger$/, 'the source exercise is a trigger');
	assert.match(trigger.solution, /^trigger \w+ on Account \(/, 'the trigger is on a standard object');
});

test('builds the requests for each exercise kind', () => {
	const { EXERCISES, buildSteps } = loadHelpers();
	const byKind = {};
	for (const e of EXERCISES) {
		byKind[e.kind] = e;
	}

	const anon = buildSteps(byKind.anonymous, 'X', { timezone: 'UTC' });
	assert.equal(anon.length, 1);
	assert.equal(anon[0].type, 'run');
	assert.equal(anon[0].request.code, 'X\n' + byKind.anonymous.checks, 'checks run after the learner code');
	assert.equal(anon[0].files, undefined);

	const src = buildSteps(byKind.source, 'T', { allExceptions: true });
	assert.equal(src.length, 1);
	assert.equal(src[0].type, 'run');
	assert.equal(src[0].request.code, byKind.source.checks);
	assert.deepEqual(Array.from(src[0].request.sourcePaths), ['/workspace/exercises/account-trigger/force-app']);
	assert.equal(src[0].files[0].path, '/workspace/exercises/account-trigger/force-app/main/default/triggers/AccountTrigger.trigger');
	assert.equal(src[0].files[0].content, 'T');
	assert.equal(src[0].request.allExceptions, true);

	const tests = buildSteps(byKind.tests, 'L', {});
	assert.equal(tests.length, 2, 'learner tests run against the provided class, then the broken copy');
	assert.ok(tests.every((m) => m.type === 'test' && m.request.verbose === true));
	const providedPath = '/workspace/exercises/discount-tests/force-app/main/default/classes/Discount.cls';
	assert.deepEqual(plain(tests[0].files.map((f) => [f.path, f.content])), [
		[providedPath, byKind.tests.provided.content],
		['/workspace/exercises/discount-tests/force-app/main/default/classes/DiscountTest.cls', 'L']
	]);
	assert.deepEqual(plain(tests[1].files.map((f) => [f.path, f.content])), [[providedPath, byKind.tests.provided.broken]]);
});

test('judges a test-writing exercise in two steps', () => {
	const { EXERCISES, judgeStep } = loadHelpers();
	const e = EXERCISES.find((x) => x.kind === 'tests');
	const pass = { tests: [{ methodName: 'a', passed: true }], total: 1, passed: 1, failed: 0 };
	const fail = { tests: [{ methodName: 'a', passed: false, errorMessage: 'boom' }], total: 1, passed: 0, failed: 1 };

	const wrong = judgeStep(e, 0, fail, 0, null);
	assert.equal(wrong.done, true, 'tests failing against the provided class end the check');
	assert.match(wrong.verdict.message, /must pass against the Discount class/);

	const first = judgeStep(e, 0, pass, 0, null);
	assert.equal(first.done, false, 'passing tests go on to the broken copy');

	const weak = judgeStep(e, 1, pass, 0, first.verdict);
	assert.equal(weak.verdict.passed, false, 'tests that also pass against the broken copy fail the exercise');
	assert.match(weak.verdict.message, /also pass against a broken copy/);

	const good = judgeStep(e, 1, fail, 0, first.verdict);
	assert.equal(good.verdict.passed, true);
	assert.equal(good.verdict.tests[0].passed, true, 'rows come from the run against the provided class');

	const none = judgeStep(e, 0, { tests: [], total: 0, error: 'x\n\nTip: y' }, 0, null);
	assert.equal(none.done, true);
	assert.equal(none.verdict.message, 'The tests could not run: x');
});

test('judges aerExec responses', () => {
	const { judgeExec } = loadHelpers();
	assert.equal(judgeExec({ error: 'busy' }, 3).kind, 'error');
	assert.equal(judgeExec({ compiled: false, compileProblem: 'bad' }, 3).kind, 'compile');
	assert.equal(judgeExec({ compiled: true, success: true }, 3).passed, true);
	const check = judgeExec({ compiled: true, success: false, line: 5, exceptionMessage: 'System.AssertException: Assertion Failed: Insert three: Expected: 3, Actual: 2' }, 3);
	assert.equal(check.kind, 'check', 'an assertion past the learner lines is a failed check');
	assert.equal(check.message, 'Insert three: Expected: 3, Actual: 2');
	assert.equal(judgeExec({ compiled: true, success: false, line: 2, exceptionMessage: 'System.AssertException: Assertion Failed: mine' }, 3).kind, 'exception', 'the learner\'s own assertion is their exception');
	assert.equal(judgeExec({ compiled: true, success: false, line: 1, exceptionMessage: 'System.AssertException: Assertion Failed: x' }, 0).kind, 'check', 'with no appended code every assertion is a check');
	assert.equal(judgeExec({ compiled: true, success: false, line: 6, exceptionMessage: 'System.NullPointerException: null' }, 3).kind, 'exception');
});

test('judges aerRunTests responses', () => {
	const { judgeTests } = loadHelpers();
	const none = judgeTests({ tests: [], total: 0, error: '"AccountTrigger", line 2: Error Unexpected token \'x\'.\n\nTip: use --skip-errors to ignore errors.' });
	assert.equal(none.passed, false, 'no tests run is a failure');
	assert.ok(!none.message.includes('Tip:'), 'command-line hints are removed');
	const failed = judgeTests({ tests: [{ methodName: 'a', passed: true }, { methodName: 'b', passed: false, errorMessage: 'first\nsecond' }], total: 2, passed: 1, failed: 1 });
	assert.equal(failed.passed, false);
	assert.equal(failed.tests[1].message, 'first', 'a failure shows its first line');
	assert.equal(judgeTests({ tests: [{ methodName: 'a', passed: true }], total: 1, passed: 1, failed: 0 }).passed, true);
});

test('filters runtime lines out of the learner output', () => {
	const { isRuntimeNoise } = loadHelpers();
	for (const line of ['[memory/wasm] grow 4 MB', 'Apex parse cache: 1 hits, 2 misses, 2 stores', 'aer: building test databases on disk in /tmp/aer-spill-1-1 to conserve memory', 'Ran 3 tests: 3 passed, 0 failed', 'FAIL Checks.a: System.AssertException: x', '']) {
		assert.equal(isRuntimeNoise(line), true, line);
	}
	for (const line of ['DEBUG | hello', 'CAUGHT EXCEPTION: type=System.TypeException message=x']) {
		assert.equal(isRuntimeNoise(line), false, line);
	}
});

test('describes the OPFS mount and stamps runtime log lines', () => {
	const { describeOpfs, formatLogLine, isMemoryAllocatorLine } = loadHelpers();
	assert.equal(isMemoryAllocatorLine('[memory/wasm] mmap reuse size=22806528 addr=0x3ef80000 active_regions=4207'), true);
	assert.equal(isMemoryAllocatorLine('aer: building test databases on disk in /tmp/aer-spill-1-1 to conserve memory'), false);
	assert.match(describeOpfs({ mounted: true, path: '/tmp', handles: 64 }), /^\/tmp is on the origin private file system \(64 file handles\)/);
	assert.match(describeOpfs({ mounted: false, reason: 'navigator.storage.getDirectory is not available' }), /not available \(navigator\.storage\.getDirectory is not available\); the runtime keeps its databases in memory/);
	assert.match(describeOpfs(undefined), /no status reported/);
	assert.equal(formatLogLine(1234, 'aer v1.6.19 is ready'), '   1.2 s  aer v1.6.19 is ready');
	assert.equal(formatLogLine(123456, 'x'), ' 123.5 s  x');
});

// Runs the aer CLI without color: node --test sets FORCE_COLOR for the test
// process when it runs in a color terminal, and aer then colors its PASS and
// FAIL labels even though its output is a pipe.
function aer(args) {
	const env = Object.assign({}, process.env, { NO_COLOR: '1' });
	delete env.FORCE_COLOR;
	const r = spawnSync('aer', args, { encoding: 'utf8', timeout: 300000, env });
	return { status: r.status, output: `aer ${args.join(' ')}\nexit ${r.status}\n${r.stdout}${r.stderr}` };
}

// The failure count from aer test's "Ran N tests: P passed, F failed" line.
function failedCount(output) {
	const m = /Ran \d+ tests?: \d+ passed, (\d+) failed/.exec(output);
	return m ? Number(m[1]) : null;
}

// Runs aer on an exercise the way the page does. Returns whether the exercise
// passes, and aer's output for the assertion message.
function checkUnderAer(e, code) {
	if (e.kind === 'anonymous') {
		const r = aer(['exec', '--timezone', 'UTC', code + '\n' + e.checks]);
		return { passes: r.status === 0, output: r.output };
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-example-'));
	try {
		const write = (rel, content) => {
			const p = path.join(dir, 'main', 'default', rel);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, content);
		};
		write(e.file, code);
		if (e.kind === 'source') {
			const r = aer(['exec', '-p', dir, '--timezone', 'UTC', e.checks]);
			return { passes: r.status === 0, output: r.output };
		}
		write(e.provided.file, e.provided.content);
		const againstProvided = aer(['test', dir, '--timezone', 'UTC']);
		if (againstProvided.status !== 0) {
			return { passes: false, output: againstProvided.output };
		}
		write(e.provided.file, e.provided.broken);
		const againstBroken = aer(['test', dir, '--timezone', 'UTC']);
		return { passes: failedCount(againstBroken.output) > 0, output: againstProvided.output + '\n' + againstBroken.output };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('every solution passes its checks and every starter fails under aer', (t) => {
	if (!hasAer()) {
		t.skip('aer is not installed');
		return;
	}
	const { EXERCISES } = loadHelpers();
	for (const e of EXERCISES) {
		const starter = checkUnderAer(e, e.starter);
		assert.equal(starter.passes, false, `${e.id} starter should fail\n${starter.output}`);
		const solution = checkUnderAer(e, e.solution);
		assert.equal(solution.passes, true, `${e.id} solution should pass\n${solution.output}`);
	}
});
