/*
 * Web Worker that runs the aer (Apex Execution Runtime) js/wasm build for a
 * page that embeds it. It downloads the runtime zip from the aer-dist
 * release proxy, installs the virtual-filesystem shims Go's wasm_exec.js
 * expects, and passes requests from the page to the runtime.
 *
 * Messages from the page:
 *   init  { zipUrl, cwd?, files? }   download and start the runtime
 *   run   { id, request, files? }    anonymous Apex through aerExec
 *   test  { id, request, files? }    @IsTest methods through aerRunTests
 * files is a list of { path, content } written to the virtual file system
 * before the request runs; a null content deletes the file.
 *
 * Messages to the page: progress, ready, error, stdout, and per request
 * debug + result (run) or test-result + test-done (test). ready carries the
 * runtime version and opfs, which says whether /tmp is on the browser's
 * origin private file system (see the OPFS section below).
 *
 * The fs shim, including the OPFS mount, is a port of the one in aer's VS
 * Code web extension worker (tools/aer-dap-client/src/extension.browser.ts).
 */
'use strict';

var encoder = new TextEncoder();
var decoder = new TextDecoder();

var fileData = new Map();
var directoryEntries = new Map();
var mtimeByPath = new Map();
var fdTable = new Map();
var nextFD = 100;
var cwdPath = '/workspace';
var outputBuf = '';

var FS_CONSTANTS = {
	O_WRONLY: 1,
	O_RDWR: 2,
	O_CREAT: 64,
	O_EXCL: 128,
	O_TRUNC: 512,
	O_APPEND: 1024,
	O_DIRECTORY: 65536
};

var CACHE_ROOT = '/cache';
var DATA_ROOT = '/cache/data';
// aer keys each cache entry by its template-format version and a schema
// hash, so runtimes of different versions can share the store.
var CACHE_DB_NAME = 'aer-cache-v1';
var CACHE_DB_STORE = 'files';
var cachePersistQueue = Promise.resolve();

var runtimeReady = null;

ensureDir('/');

function fsError(code, message) {
	var error = new Error(message || code);
	error.code = code;
	return error;
}

function normalizePath(input) {
	var working = String(input || '/').replace(/\\/g, '/');
	if (working === '') {
		working = '/';
	}
	if (working.charAt(0) !== '/') {
		working = cwdPath + '/' + working;
	}
	var parts = [];
	working.split('/').forEach(function (part) {
		if (!part || part === '.') {
			return;
		}
		if (part === '..') {
			parts.pop();
			return;
		}
		parts.push(part);
	});
	return '/' + parts.join('/');
}

function dirname(path) {
	var normalized = normalizePath(path);
	if (normalized === '/') {
		return '/';
	}
	var idx = normalized.lastIndexOf('/');
	return idx <= 0 ? '/' : normalized.slice(0, idx);
}

function basename(path) {
	var normalized = normalizePath(path);
	if (normalized === '/') {
		return '/';
	}
	return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function ensureDir(path) {
	var normalized = normalizePath(path);
	if (directoryEntries.has(normalized)) {
		if (!mtimeByPath.has(normalized)) {
			mtimeByPath.set(normalized, Date.now());
		}
		return;
	}
	if (normalized !== '/') {
		var parent = dirname(normalized);
		ensureDir(parent);
		directoryEntries.get(parent).add(basename(normalized));
		mtimeByPath.set(parent, Date.now());
	}
	directoryEntries.set(normalized, new Set());
	mtimeByPath.set(normalized, Date.now());
}

function writeVirtualFile(path, bytes) {
	var normalized = normalizePath(path);
	ensureDir(dirname(normalized));
	directoryEntries.get(dirname(normalized)).add(basename(normalized));
	fileData.set(normalized, bytes);
	mtimeByPath.set(normalized, Date.now());
	mtimeByPath.set(dirname(normalized), Date.now());
}

function deleteVirtualFile(path) {
	var normalized = normalizePath(path);
	fileData.delete(normalized);
	mtimeByPath.delete(normalized);
	var children = directoryEntries.get(dirname(normalized));
	if (children) {
		children.delete(basename(normalized));
	}
	mtimeByPath.set(dirname(normalized), Date.now());
	schedulePersistDelete(normalized);
}

function statForPath(path) {
	var normalized = normalizePath(path);
	if (isOpfsPath(normalized) && opfsMount.files.has(normalized)) {
		return createStats(normalized, false, opfsMount.files.get(normalized).size);
	}
	if (fileData.has(normalized)) {
		return createStats(normalized, false, fileData.get(normalized).length);
	}
	if (directoryEntries.has(normalized)) {
		return createStats(normalized, true, directoryEntries.get(normalized).size);
	}
	return null;
}

function createStats(path, isDir, size) {
	var normalized = normalizePath(path);
	if (!mtimeByPath.has(normalized)) {
		mtimeByPath.set(normalized, Date.now());
	}
	var mtime = mtimeByPath.get(normalized);
	return {
		dev: 1,
		ino: 1,
		mode: isDir ? 16877 : 33188,
		nlink: 1,
		uid: 0,
		gid: 0,
		rdev: 0,
		size: size,
		blksize: 4096,
		blocks: 1,
		atimeMs: mtime,
		mtimeMs: mtime,
		ctimeMs: mtime,
		isDirectory: function () { return isDir; },
		isFile: function () { return !isDir; }
	};
}

function cloneBytes(bytes) {
	var out = new Uint8Array(bytes.length);
	out.set(bytes);
	return out;
}

/* ---------- In-memory file growth ---------- */

// Buffers allocated by growFileBytes, which may hold spare capacity past the
// end of the file that uses them.
var growableBuffers = new WeakSet();

// growFileBytes returns a view of end bytes over the contents of existing,
// reusing spare capacity of a buffer this function allocated and otherwise
// allocating at least twice the current length, so a file written in small
// chunks is not copied whole on every write. Bytes past the old length are zero.
function growFileBytes(existing, end) {
	if (end <= existing.length) {
		return existing;
	}
	if (growableBuffers.has(existing.buffer) && existing.byteOffset + end <= existing.buffer.byteLength) {
		return new Uint8Array(existing.buffer, existing.byteOffset, end);
	}
	var buffer = new ArrayBuffer(Math.max(end, existing.length * 2));
	growableBuffers.add(buffer);
	var next = new Uint8Array(buffer, 0, end);
	next.set(existing);
	return next;
}

// truncateFileBytes returns the contents of existing cut or zero-extended to
// length bytes. A cut copies, so no buffer keeps stale bytes past its view.
function truncateFileBytes(existing, length) {
	if (length < existing.length) {
		return cloneBytes(existing.subarray(0, length));
	}
	return growFileBytes(existing, length);
}

/* ---------- OPFS mount for /tmp ---------- */

// Files under OPFS_MOUNT_PATH live in the browser's origin private file system
// (OPFS) instead of in this worker's memory. When the runtime finds
// AER_WASM_OPFS_DIR in its environment, it builds its SQLite databases (the
// org template and the per-test copies) as files there, so they are not
// limited by wasm linear memory (4 GiB) and a large project fits. Without the
// mount the databases stay in memory, which is enough for small projects.
//
// Go's js syscall layer calls the fs functions below and expects each
// callback before the call returns; a test run is one synchronous call into
// Go, during which no promise can settle. Every mount operation is therefore
// synchronous: files are served from a pool of FileSystemSyncAccessHandles
// opened in advance, a path is bound to a free handle when the file is
// created, and the handle returns to the pool when the file is deleted. The
// pool grows asynchronously, which only progresses while the runtime is idle,
// between runs. Each worker owns one directory under OPFS_BASE_DIR and holds a
// sync access handle on its lock file for its lifetime; a worker that starts
// later removes the directories whose lock files it can open, since their
// owners have exited.
//
// This is a port of the mount in aer's VS Code web extension worker
// (tools/aer-dap-client/src/extension.browser.ts).
var OPFS_MOUNT_PATH = '/tmp';
var OPFS_BASE_DIR = 'aer-tmp';
var OPFS_LOCK_SUFFIX = '.lock';
var OPFS_POOL_INITIAL = 64;
var OPFS_POOL_LOW_WATER = 16;
var OPFS_POOL_GROW_BY = 32;
var OPFS_ENV_VAR = 'AER_WASM_OPFS_DIR';
var opfsMount = null;
var opfsUnavailableReason = 'not initialized';

function opfsErrorName(error) {
	return (error && typeof error === 'object' && typeof error.name === 'string') ? error.name : String(error);
}

function opfsIOError(operation, error) {
	if (error && typeof error === 'object' && typeof error.code === 'string') {
		return error;
	}
	return fsError('EIO', 'OPFS ' + operation + ' failed: ' + String(error));
}

async function initOpfsMount() {
	if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
		opfsUnavailableReason = 'navigator.storage.getDirectory is not available';
		return null;
	}
	try {
		var root = await navigator.storage.getDirectory();
		var base = await root.getDirectoryHandle(OPFS_BASE_DIR, { create: true });
		await removeStaleOpfsWorkerDirs(base);
		var workerId = 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
		// The lock file is created and opened before the directory exists, so
		// another worker's cleanup never sees the directory without its lock.
		var lockFile = await base.getFileHandle(workerId + OPFS_LOCK_SUFFIX, { create: true });
		var lockHandle = await lockFile.createSyncAccessHandle();
		var dir = await base.getDirectoryHandle(workerId, { create: true });
		var mount = { base: base, workerId: workerId, dir: dir, lockHandle: lockHandle, free: [], files: new Map(), nextFileName: 0, growing: null };
		await growOpfsPool(mount, OPFS_POOL_INITIAL);
		opfsMount = mount;
		return mount;
	} catch (error) {
		opfsUnavailableReason = 'mount failed: ' + String(error);
		return null;
	}
}

// removeStaleOpfsWorkerDirs deletes the directories of workers that have
// exited. A running worker holds a sync access handle on its lock file, and
// creating a second handle on that file fails with NoModificationAllowedError,
// so a lock file that opens belongs to a worker that is gone. A directory
// without a lock file is removed as well: the lock is created before the
// directory, so its absence means the lock was already removed.
async function removeStaleOpfsWorkerDirs(base) {
	var entries = [];
	for await (var entry of base.values()) {
		entries.push({ name: entry.name, kind: entry.kind });
	}
	var liveWorkers = new Set();
	for (var i = 0; i < entries.length; i++) {
		var e = entries[i];
		if (e.kind !== 'file' || !e.name.endsWith(OPFS_LOCK_SUFFIX)) {
			continue;
		}
		var handle = null;
		try {
			var lockFile = await base.getFileHandle(e.name);
			handle = await lockFile.createSyncAccessHandle();
		} catch (error) {
			if (opfsErrorName(error) === 'NoModificationAllowedError') {
				liveWorkers.add(e.name.slice(0, -OPFS_LOCK_SUFFIX.length));
				continue;
			}
			throw error;
		}
		handle.close();
	}
	for (var j = 0; j < entries.length; j++) {
		var f = entries[j];
		var isLock = f.kind === 'file' && f.name.endsWith(OPFS_LOCK_SUFFIX);
		var id = isLock ? f.name.slice(0, -OPFS_LOCK_SUFFIX.length) : f.name;
		if (liveWorkers.has(id)) {
			continue;
		}
		await base.removeEntry(f.name, { recursive: f.kind === 'directory' });
	}
}

async function growOpfsPool(mount, count) {
	var opened = await Promise.all(Array.from({ length: count }, async function () {
		var name = 'f' + (mount.nextFileName++).toString(36);
		var fileHandle = await mount.dir.getFileHandle(name, { create: true });
		var handle = await fileHandle.createSyncAccessHandle();
		return { name: name, handle: handle };
	}));
	opened.forEach(function (slot) {
		mount.free.push(slot);
	});
}

function scheduleOpfsPoolGrowth(mount) {
	if (mount.growing || mount.free.length >= OPFS_POOL_LOW_WATER) {
		return;
	}
	mount.growing = growOpfsPool(mount, OPFS_POOL_GROW_BY)
		.catch(function (error) {
			console.warn('OPFS pool growth failed', error);
		})
		.then(function () {
			mount.growing = null;
		});
}

function isOpfsPath(normalized) {
	return opfsMount !== null && (normalized === OPFS_MOUNT_PATH || normalized.indexOf(OPFS_MOUNT_PATH + '/') === 0);
}

// opfsCreateFile binds a free handle to normalized and adds the name to its
// directory. ENOSPC when the pool is empty: growth is asynchronous and cannot
// complete during a synchronous run.
function opfsCreateFile(normalized) {
	var mount = opfsMount;
	var slot = mount.free.pop();
	if (!slot) {
		scheduleOpfsPoolGrowth(mount);
		throw fsError('ENOSPC', 'no free OPFS file handles for ' + normalized);
	}
	var file = { name: slot.name, handle: slot.handle, size: 0, refs: 0, unlinked: false };
	mount.files.set(normalized, file);
	var parent = dirname(normalized);
	ensureDir(parent);
	directoryEntries.get(parent).add(basename(normalized));
	mtimeByPath.set(normalized, Date.now());
	mtimeByPath.set(parent, Date.now());
	scheduleOpfsPoolGrowth(mount);
	return file;
}

// opfsForgetFile removes normalized from its directory. The handle returns to
// the pool now, or when the last descriptor open on the file closes, so a
// file deleted while open stays readable and writable through its descriptors.
function opfsForgetFile(normalized, file) {
	opfsMount.files.delete(normalized);
	mtimeByPath.delete(normalized);
	var parent = dirname(normalized);
	var children = directoryEntries.get(parent);
	if (children) {
		children.delete(basename(normalized));
	}
	mtimeByPath.set(parent, Date.now());
	if (file.refs > 0) {
		file.unlinked = true;
		return;
	}
	opfsReleaseFile(file);
}

function opfsReleaseFile(file) {
	file.handle.truncate(0);
	file.size = 0;
	opfsMount.free.push({ name: file.name, handle: file.handle });
}

function opfsCloseFile(file) {
	file.refs--;
	if (file.refs === 0 && file.unlinked) {
		opfsReleaseFile(file);
	}
}

function opfsStatus() {
	if (opfsMount) {
		return { mounted: true, path: OPFS_MOUNT_PATH, handles: opfsMount.free.length + opfsMount.files.size };
	}
	return { mounted: false, reason: opfsUnavailableReason };
}

// runtimeEnv is the environment the Go runtime starts with. It names the OPFS
// mount only when the mount exists, so the runtime keeps its databases in
// memory when it does not.
function runtimeEnv() {
	var env = {
		HOME: '/home/web',
		XDG_CACHE_HOME: CACHE_ROOT,
		XDG_DATA_HOME: DATA_ROOT,
		TMPDIR: '/tmp'
	};
	if (opfsMount) {
		env[OPFS_ENV_VAR] = OPFS_MOUNT_PATH;
	}
	return env;
}

function writeToOpfsEntry(entry, chunk, position) {
	var file = entry.opfs;
	var start = position != null ? position : (entry.append ? file.size : entry.position);
	var written = file.handle.write(chunk, { at: start });
	if (start + written > file.size) {
		file.size = start + written;
	}
	if (position == null) {
		entry.position = start + written;
	}
	mtimeByPath.set(entry.path, Date.now());
	return written;
}

// writeToMemoryEntry writes chunk to the in-memory file behind entry. The file
// is saved to IndexedDB when the descriptor closes rather than on every write,
// so a file written in chunks reaches the cache database once.
function writeToMemoryEntry(entry, chunk, position) {
	var existing = fileData.get(entry.path) || new Uint8Array(0);
	var start = position != null ? position : (entry.append ? existing.length : entry.position);
	var next = growFileBytes(existing, start + chunk.length);
	next.set(chunk, start);
	fileData.set(entry.path, next);
	mtimeByPath.set(entry.path, Date.now());
	mtimeByPath.set(dirname(entry.path), Date.now());
	if (position == null) {
		entry.position = start + chunk.length;
	}
	entry.dirty = true;
	return chunk.length;
}

/* ---------- IndexedDB persistence for /cache (aer's schema/template cache) ---------- */

function shouldPersistPath(path) {
	var normalized = normalizePath(path);
	return normalized === CACHE_ROOT || normalized.indexOf(CACHE_ROOT + '/') === 0;
}

function openCacheDB() {
	if (typeof indexedDB === 'undefined') {
		return Promise.resolve(null);
	}
	return new Promise(function (resolve, reject) {
		var request = indexedDB.open(CACHE_DB_NAME, 1);
		request.onupgradeneeded = function () {
			var db = request.result;
			if (!db.objectStoreNames.contains(CACHE_DB_STORE)) {
				db.createObjectStore(CACHE_DB_STORE, { keyPath: 'path' });
			}
		};
		request.onsuccess = function () { resolve(request.result); };
		request.onerror = function () { reject(request.error || new Error('failed to open cache database')); };
	});
}

function enqueueCachePersist(operation) {
	cachePersistQueue = cachePersistQueue.then(operation).catch(function (error) {
		console.warn('cache persistence failed', error);
	});
}

function schedulePersistWrite(path, bytes) {
	if (!shouldPersistPath(path)) {
		return;
	}
	var normalized = normalizePath(path);
	var snapshot = cloneBytes(bytes);
	enqueueCachePersist(function () {
		return openCacheDB().then(function (db) {
			if (!db) {
				return;
			}
			return new Promise(function (resolve, reject) {
				var tx = db.transaction(CACHE_DB_STORE, 'readwrite');
				var request = tx.objectStore(CACHE_DB_STORE).put({
					path: normalized,
					bytes: snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength)
				});
				request.onsuccess = function () { resolve(); };
				request.onerror = function () { reject(request.error); };
			});
		});
	});
}

function schedulePersistDelete(path) {
	if (!shouldPersistPath(path)) {
		return;
	}
	var normalized = normalizePath(path);
	enqueueCachePersist(function () {
		return openCacheDB().then(function (db) {
			if (!db) {
				return;
			}
			return new Promise(function (resolve, reject) {
				var request = db.transaction(CACHE_DB_STORE, 'readwrite').objectStore(CACHE_DB_STORE).delete(normalized);
				request.onsuccess = function () { resolve(); };
				request.onerror = function () { reject(request.error); };
			});
		});
	});
}

function loadPersistentCache() {
	return openCacheDB().then(function (db) {
		if (!db) {
			return;
		}
		return new Promise(function (resolve) {
			var request = db.transaction(CACHE_DB_STORE, 'readonly').objectStore(CACHE_DB_STORE).getAll();
			request.onsuccess = function () {
				(request.result || []).forEach(function (entry) {
					if (!entry || typeof entry.path !== 'string' || !shouldPersistPath(entry.path)) {
						return;
					}
					var bytes = null;
					if (entry.bytes instanceof ArrayBuffer) {
						bytes = new Uint8Array(entry.bytes);
					} else if (ArrayBuffer.isView(entry.bytes)) {
						bytes = new Uint8Array(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
					}
					if (bytes) {
						writeVirtualFile(entry.path, cloneBytes(bytes));
					}
				});
				resolve();
			};
			request.onerror = function () { resolve(); };
		});
	}).catch(function (error) {
		console.warn('failed to load persisted cache', error);
	});
}

/* ---------- Node shims for wasm_exec.js ---------- */

function installNodeShims() {
	ensureDir('/tmp');
	ensureDir('/home');
	ensureDir('/home/web');
	ensureDir(CACHE_ROOT);
	ensureDir(DATA_ROOT);
	ensureDir(cwdPath);

	self.process = {
		pid: 1,
		ppid: 1,
		env: runtimeEnv(),
		cwd: function () { return cwdPath; },
		chdir: function (nextPath) {
			var normalized = normalizePath(nextPath);
			if (!directoryEntries.has(normalized)) {
				throw fsError('ENOENT', 'directory not found');
			}
			cwdPath = normalized;
		},
		getuid: function () { return 0; },
		getgid: function () { return 0; },
		geteuid: function () { return 0; },
		getegid: function () { return 0; },
		getgroups: function () { return []; },
		umask: function () { return 0; }
	};

	self.path = {
		resolve: function () {
			var current = '';
			for (var i = 0; i < arguments.length; i++) {
				var seg = arguments[i];
				if (typeof seg !== 'string' || seg === '') {
					continue;
				}
				if (seg.charAt(0) === '/') {
					current = seg;
				} else if (current === '') {
					current = cwdPath + '/' + seg;
				} else {
					current = current + '/' + seg;
				}
			}
			return normalizePath(current || cwdPath);
		}
	};

	self.fs = {
		constants: FS_CONSTANTS,
		writeSync: function (fd, buf) {
			if (fd === 1 || fd === 2 || !fdTable.has(fd)) {
				outputBuf += decoder.decode(buf);
				var newlineIndex = outputBuf.indexOf('\n');
				while (newlineIndex >= 0) {
					var line = outputBuf.slice(0, newlineIndex).replace(/\r$/, '');
					self.postMessage({ type: 'stdout', line: line });
					outputBuf = outputBuf.slice(newlineIndex + 1);
					newlineIndex = outputBuf.indexOf('\n');
				}
				return buf.length;
			}
			var entry = fdTable.get(fd);
			if (!entry || entry.isDir || !entry.writable) {
				throw fsError('EBADF', 'bad file descriptor');
			}
			var chunk = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
			if (entry.opfs) {
				try {
					return writeToOpfsEntry(entry, chunk, null);
				} catch (error) {
					throw opfsIOError('write', error);
				}
			}
			return writeToMemoryEntry(entry, chunk, null);
		},
		write: function (fd, buf, offset, length, position, callback) {
			if (fd === 1 || fd === 2 || !fdTable.has(fd)) {
				if (offset !== 0 || length !== buf.length || position !== null) {
					callback(fsError('EINVAL', 'unsupported write arguments'));
					return;
				}
				try {
					callback(null, this.writeSync(fd, buf), buf);
				} catch (error) {
					callback(error);
				}
				return;
			}
			var entry = fdTable.get(fd);
			if (!entry || entry.isDir || !entry.writable) {
				callback(fsError('EBADF', 'bad file descriptor'));
				return;
			}
			var startOffset = Math.max(0, offset || 0);
			var endOffset = Math.min(buf.length, startOffset + Math.max(0, length || 0));
			var chunk = buf.subarray(startOffset, endOffset);
			var written;
			try {
				written = entry.opfs ? writeToOpfsEntry(entry, chunk, position) : writeToMemoryEntry(entry, chunk, position);
			} catch (error) {
				callback(opfsIOError('write', error));
				return;
			}
			callback(null, written, buf);
		},
		open: function (path, flags, _mode, callback) {
			var normalized = normalizePath(path);
			var writable = (flags & (FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_RDWR)) !== 0;
			var create = (flags & FS_CONSTANTS.O_CREAT) !== 0;
			var exclusive = (flags & FS_CONSTANTS.O_EXCL) !== 0;
			var trunc = (flags & FS_CONSTANTS.O_TRUNC) !== 0;
			var append = (flags & FS_CONSTANTS.O_APPEND) !== 0;
			var fd;

			if (isOpfsPath(normalized) && !directoryEntries.has(normalized)) {
				var file = opfsMount.files.get(normalized) || null;
				try {
					if (!file) {
						if (!create) {
							callback(fsError('ENOENT', 'file not found'));
							return;
						}
						file = opfsCreateFile(normalized);
					} else if (exclusive && create) {
						callback(fsError('EEXIST', 'file exists'));
						return;
					}
					if (trunc && writable && file.size > 0) {
						file.handle.truncate(0);
						file.size = 0;
						mtimeByPath.set(normalized, Date.now());
					}
				} catch (error) {
					callback(opfsIOError('open', error));
					return;
				}
				file.refs++;
				fd = nextFD++;
				fdTable.set(fd, { path: normalized, position: append ? file.size : 0, isDir: false, writable: writable, append: append, opfs: file });
				callback(null, fd);
				return;
			}

			var stats = statForPath(normalized);
			if (!stats) {
				if (!create) {
					callback(fsError('ENOENT', 'file not found'));
					return;
				}
				writeVirtualFile(normalized, new Uint8Array(0));
				stats = statForPath(normalized);
			} else if (exclusive && create) {
				callback(fsError('EEXIST', 'file exists'));
				return;
			}
			if (stats.isDirectory()) {
				if (writable) {
					callback(fsError('EISDIR', 'is a directory'));
					return;
				}
				fd = nextFD++;
				fdTable.set(fd, { path: normalized, position: 0, isDir: true, writable: false, append: false });
				callback(null, fd);
				return;
			}
			if (trunc && writable) {
				fileData.set(normalized, new Uint8Array(0));
				mtimeByPath.set(normalized, Date.now());
				schedulePersistWrite(normalized, new Uint8Array(0));
			}
			fd = nextFD++;
			fdTable.set(fd, {
				path: normalized,
				position: append ? (fileData.get(normalized) || new Uint8Array(0)).length : 0,
				isDir: false,
				writable: writable,
				append: append,
				dirty: false
			});
			callback(null, fd);
		},
		close: function (fd, callback) {
			var entry = fdTable.get(fd);
			fdTable.delete(fd);
			if (entry && entry.opfs) {
				try {
					opfsCloseFile(entry.opfs);
				} catch (error) {
					callback(opfsIOError('close', error));
					return;
				}
			} else if (entry && entry.dirty && fileData.has(entry.path)) {
				schedulePersistWrite(entry.path, fileData.get(entry.path));
			}
			callback(null);
		},
		fstat: function (fd, callback) {
			var entry = fdTable.get(fd);
			if (!entry) {
				callback(fsError('EBADF', 'bad file descriptor'));
				return;
			}
			if (entry.opfs) {
				callback(null, createStats(entry.path, false, entry.opfs.size));
				return;
			}
			var stats = statForPath(entry.path);
			if (!stats) {
				callback(fsError('ENOENT', 'file not found'));
				return;
			}
			callback(null, stats);
		},
		stat: function (path, callback) {
			var stats = statForPath(path);
			if (!stats) {
				callback(fsError('ENOENT', 'path not found'));
				return;
			}
			callback(null, stats);
		},
		lstat: function (path, callback) {
			this.stat(path, callback);
		},
		readdir: function (path, callback) {
			var children = directoryEntries.get(normalizePath(path));
			if (!children) {
				callback(fsError('ENOENT', 'directory not found'));
				return;
			}
			callback(null, Array.from(children.values()).sort());
		},
		read: function (fd, buffer, offset, length, position, callback) {
			var entry = fdTable.get(fd);
			if (!entry) {
				callback(fsError('EBADF', 'bad file descriptor'));
				return;
			}
			if (entry.isDir) {
				callback(fsError('EISDIR', 'is a directory'));
				return;
			}
			var start = position != null ? position : entry.position;
			var readBytes;
			if (entry.opfs) {
				try {
					readBytes = entry.opfs.handle.read(buffer.subarray(offset, offset + length), { at: start });
				} catch (error) {
					callback(opfsIOError('read', error));
					return;
				}
				if (position == null) {
					entry.position = start + readBytes;
				}
				callback(null, readBytes, buffer);
				return;
			}
			var bytes = fileData.get(entry.path);
			if (!bytes) {
				callback(fsError('ENOENT', 'file not found'));
				return;
			}
			var end = Math.min(start + length, bytes.length);
			readBytes = Math.max(0, end - start);
			buffer.set(bytes.subarray(start, end), offset);
			if (position == null) {
				entry.position = end;
			}
			callback(null, readBytes, buffer);
		},
		chmod: function (_path, _mode, callback) { callback(null); },
		chown: function (_path, _uid, _gid, callback) { callback(null); },
		fchmod: function (_fd, _mode, callback) { callback(null); },
		fchown: function (_fd, _uid, _gid, callback) { callback(null); },
		fsync: function (fd, callback) {
			var entry = fdTable.get(fd);
			if (entry && entry.opfs) {
				try {
					entry.opfs.handle.flush();
				} catch (error) {
					callback(opfsIOError('fsync', error));
					return;
				}
			}
			callback(null);
		},
		ftruncate: function (fd, len, callback) {
			var entry = fdTable.get(fd);
			if (!entry || entry.isDir || !entry.writable) {
				callback(fsError('EBADF', 'bad file descriptor'));
				return;
			}
			var length = Math.max(0, len || 0);
			if (entry.opfs) {
				try {
					entry.opfs.handle.truncate(length);
				} catch (error) {
					callback(opfsIOError('ftruncate', error));
					return;
				}
				entry.opfs.size = length;
				mtimeByPath.set(entry.path, Date.now());
				callback(null);
				return;
			}
			var existing = fileData.get(entry.path);
			if (!existing) {
				callback(fsError('ENOENT', 'file not found'));
				return;
			}
			fileData.set(entry.path, truncateFileBytes(existing, length));
			mtimeByPath.set(entry.path, Date.now());
			entry.dirty = true;
			callback(null);
		},
		lchown: function (_path, _uid, _gid, callback) { callback(null); },
		link: function (_path, _link, callback) { callback(fsError('EROFS', 'read-only filesystem')); },
		mkdir: function (path, _perm, callback) {
			ensureDir(path);
			callback(null);
		},
		readlink: function (_path, callback) { callback(fsError('EINVAL', 'not a symlink')); },
		rename: function (from, to, callback) {
			var src = normalizePath(from);
			var dst = normalizePath(to);
			var srcOnMount = isOpfsPath(src);
			if (srcOnMount !== isOpfsPath(dst)) {
				callback(fsError('EXDEV', 'cannot rename across the OPFS mount boundary'));
				return;
			}
			if (directoryEntries.has(dst)) {
				callback(fsError('EISDIR', 'destination is a directory'));
				return;
			}
			if (srcOnMount) {
				var file = opfsMount.files.get(src);
				if (!file) {
					callback(fsError('ENOENT', 'file not found'));
					return;
				}
				try {
					var replaced = opfsMount.files.get(dst);
					if (replaced && replaced !== file) {
						opfsForgetFile(dst, replaced);
					}
					opfsMount.files.delete(src);
					mtimeByPath.delete(src);
					var srcChildren = directoryEntries.get(dirname(src));
					if (srcChildren) {
						srcChildren.delete(basename(src));
					}
					mtimeByPath.set(dirname(src), Date.now());
					opfsMount.files.set(dst, file);
					ensureDir(dirname(dst));
					directoryEntries.get(dirname(dst)).add(basename(dst));
					mtimeByPath.set(dst, Date.now());
					mtimeByPath.set(dirname(dst), Date.now());
				} catch (error) {
					callback(opfsIOError('rename', error));
					return;
				}
				callback(null);
				return;
			}
			var bytes = fileData.get(src);
			if (!bytes) {
				callback(fsError('ENOENT', 'file not found'));
				return;
			}
			if (fileData.has(dst)) {
				deleteVirtualFile(dst);
			}
			writeVirtualFile(dst, cloneBytes(bytes));
			schedulePersistWrite(dst, bytes);
			deleteVirtualFile(src);
			callback(null);
		},
		rmdir: function (path, callback) {
			var normalized = normalizePath(path);
			var children = directoryEntries.get(normalized);
			if (!children || children.size > 0) {
				callback(fsError('ENOTEMPTY', 'directory not empty'));
				return;
			}
			directoryEntries.delete(normalized);
			mtimeByPath.delete(normalized);
			var parentChildren = directoryEntries.get(dirname(normalized));
			if (parentChildren) {
				parentChildren.delete(basename(normalized));
			}
			mtimeByPath.set(dirname(normalized), Date.now());
			callback(null);
		},
		symlink: function (_path, _link, callback) { callback(fsError('EROFS', 'read-only filesystem')); },
		truncate: function (_path, _length, callback) { callback(fsError('EROFS', 'read-only filesystem')); },
		unlink: function (path, callback) {
			var normalized = normalizePath(path);
			if (isOpfsPath(normalized)) {
				var file = opfsMount.files.get(normalized);
				if (!file) {
					callback(directoryEntries.has(normalized) ? fsError('EISDIR', 'is a directory') : fsError('ENOENT', 'file not found'));
					return;
				}
				try {
					opfsForgetFile(normalized, file);
				} catch (error) {
					callback(opfsIOError('unlink', error));
					return;
				}
				callback(null);
				return;
			}
			if (!fileData.has(normalized)) {
				callback(fsError('ENOENT', 'file not found'));
				return;
			}
			deleteVirtualFile(normalized);
			callback(null);
		},
		utimes: function (_path, _atime, _mtime, callback) { callback(null); }
	};
}

/* ---------- Runtime zip download and extraction ---------- */

function fetchBytesWithProgress(url, onProgress) {
	return fetch(url, { headers: { Accept: 'application/octet-stream' } }).then(function (res) {
		if (!res.ok) {
			throw new Error('HTTP ' + res.status + ' while downloading ' + url);
		}
		var total = parseInt(res.headers.get('Content-Length') || '0', 10);
		if (!res.body || !res.body.getReader) {
			return res.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
		}
		var reader = res.body.getReader();
		var chunks = [];
		var received = 0;
		function pump() {
			return reader.read().then(function (step) {
				if (step.done) {
					var out = new Uint8Array(received);
					var offset = 0;
					chunks.forEach(function (chunk) {
						out.set(chunk, offset);
						offset += chunk.length;
					});
					return out;
				}
				chunks.push(step.value);
				received += step.value.length;
				if (onProgress) {
					onProgress(received, total);
				}
				return pump();
			});
		}
		return pump();
	});
}

function inflateRaw(compressedData) {
	var input = Uint8Array.from(compressedData);
	var stream = new Blob([input.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
}

function extractWasmRuntimeFromZip(zipBytes) {
	var zipView = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
	var offset = 0;
	var entries = [];
	while (offset + 4 <= zipView.byteLength) {
		var signature = zipView.getUint32(offset, true);
		if (signature !== 0x04034b50) {
			break;
		}
		var generalPurposeBits = zipView.getUint16(offset + 6, true);
		var compressionMethod = zipView.getUint16(offset + 8, true);
		var compressedSize = zipView.getUint32(offset + 18, true);
		var fileNameLength = zipView.getUint16(offset + 26, true);
		var extraLength = zipView.getUint16(offset + 28, true);
		if ((generalPurposeBits & 0x08) !== 0) {
			throw new Error('Unsupported wasm zip: data descriptor entries');
		}
		var fileNameStart = offset + 30;
		var dataStart = fileNameStart + fileNameLength + extraLength;
		var dataEnd = dataStart + compressedSize;
		if (dataEnd > zipView.byteLength) {
			throw new Error('Invalid wasm zip: truncated entry');
		}
		var fileName = decoder.decode(zipBytes.subarray(fileNameStart, fileNameStart + fileNameLength));
		entries.push({
			name: fileName.replace(/\\/g, '/').split('/').pop(),
			method: compressionMethod,
			data: zipBytes.subarray(dataStart, dataEnd)
		});
		offset = dataEnd;
	}

	var wasmBytes = null;
	var wasmExecBytes = null;
	var chain = Promise.resolve();
	entries.forEach(function (entry) {
		if (entry.name !== 'aer.wasm' && entry.name !== 'aer-web.wasm' && entry.name !== 'wasm_exec.js') {
			return;
		}
		chain = chain.then(function () {
			var decoded = entry.method === 0 ? Promise.resolve(entry.data) : inflateRaw(entry.data);
			return decoded.then(function (data) {
				if (entry.name === 'wasm_exec.js') {
					wasmExecBytes = data;
				} else {
					wasmBytes = data;
				}
			});
		});
	});
	return chain.then(function () {
		if (!wasmBytes || !wasmExecBytes) {
			throw new Error('Wasm zip missing aer.wasm or wasm_exec.js');
		}
		return { wasmBytes: wasmBytes, wasmExecSource: decoder.decode(wasmExecBytes) };
	});
}

function waitForGlobal(name, timeoutMs) {
	var startedAt = Date.now();
	return new Promise(function (resolve, reject) {
		(function poll() {
			if (typeof self[name] === 'function') {
				resolve();
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				reject(new Error(name + ' did not appear after go.run()'));
				return;
			}
			setTimeout(poll, 50);
		})();
	});
}

/* ---------- Worker protocol ---------- */

function progress(stage, detail) {
	self.postMessage({ type: 'progress', stage: stage, detail: detail || '' });
}

function startRuntime(init) {
	if (typeof init.cwd === 'string' && init.cwd.charAt(0) === '/') {
		cwdPath = normalizePath(init.cwd);
	}
	// Opening the OPFS handles overlaps the download. The mount decides
	// where the runtime puts its databases, so it is settled before the
	// runtime starts.
	var mountReady = initOpfsMount();
	return loadPersistentCache().then(function () {
		progress('download', 'Fetching the aer runtime…');
		return fetchBytesWithProgress(init.zipUrl, function (received, total) {
			progress('download', total > 0
				? 'Fetching the aer runtime… ' + Math.round(received / 1048576) + ' / ' + Math.round(total / 1048576) + ' MB'
				: 'Fetching the aer runtime… ' + Math.round(received / 1048576) + ' MB');
		});
	}).then(function (zipBytes) {
		progress('extract', 'Unpacking the runtime…');
		return extractWasmRuntimeFromZip(zipBytes);
	}).then(function (runtime) {
		return mountReady.then(function () { return runtime; });
	}).then(function (runtime) {
		progress('boot', 'Starting the wasm VM…');
		(0, eval)(runtime.wasmExecSource);
		installNodeShims();

		(init.files || []).forEach(function (file) {
			writeVirtualFile(file.path, encoder.encode(file.content));
		});

		var go = new self.Go();
		go.env = Object.assign({}, go.env || {}, runtimeEnv());
		return WebAssembly.instantiate(runtime.wasmBytes, go.importObject).then(function (result) {
			go.run(result.instance);
			return waitForGlobal('aerExec', 10000);
		});
	}).then(function () {
		var version = typeof self.aerWasmVersion === 'function' ? self.aerWasmVersion() : 'dev';
		self.postMessage({ type: 'ready', version: version, opfs: opfsStatus() });
	});
}

function writeFiles(files) {
	(files || []).forEach(function (file) {
		if (file.content === null) {
			if (fileData.has(normalizePath(file.path))) {
				deleteVirtualFile(file.path);
			}
			return;
		}
		writeVirtualFile(file.path, encoder.encode(file.content));
	});
}

self.onmessage = function (event) {
	var message = event.data || {};

	if (message.type === 'init') {
		if (!runtimeReady) {
			runtimeReady = startRuntime(message).catch(function (error) {
				self.postMessage({ type: 'error', message: String(error && error.message || error) });
				throw error;
			});
		}
		return;
	}

	// Exercise pages send the learner's files with each request. Writing
	// them before the request runs means the request always sees the
	// files that belong to it.
	writeFiles(message.files);

	if (message.type === 'test') {
		var testId = message.id;
		if (!runtimeReady) {
			self.postMessage({ type: 'test-done', id: testId, response: { error: 'runtime is not initialized' } });
			return;
		}
		runtimeReady.then(function () {
			self.aerEmitTestResult = function (json) {
				self.postMessage({ type: 'test-result', id: testId, test: JSON.parse(json) });
			};
			// aerRunTests returns its JSON synchronously, not a Promise.
			var raw = self.aerRunTests(JSON.stringify(message.request));
			self.postMessage({ type: 'test-done', id: testId, response: JSON.parse(raw) });
		}).catch(function (error) {
			self.postMessage({ type: 'test-done', id: testId, response: { error: String(error && error.message || error) } });
		});
		return;
	}

	if (message.type === 'run') {
		var id = message.id;
		if (!runtimeReady) {
			self.postMessage({ type: 'result', id: id, response: { error: 'runtime is not initialized' } });
			return;
		}
		runtimeReady.then(function () {
			self.aerEmitDebugLine = function (line) {
				self.postMessage({ type: 'debug', id: id, line: line });
			};
			return Promise.resolve(self.aerExec(JSON.stringify(message.request))).then(function (raw) {
				var response;
				try {
					response = JSON.parse(raw);
				} catch (_error) {
					response = { error: 'unparseable runtime response' };
				}
				self.postMessage({ type: 'result', id: id, response: response });
			});
		}).catch(function (error) {
			self.postMessage({ type: 'result', id: id, response: { error: String(error && error.message || error) } });
		});
	}
};
