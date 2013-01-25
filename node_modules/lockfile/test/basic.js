var test = require('tap').test
var lockFile = require('../lockfile.js')
var path = require('path')
var fs = require('fs')

test('setup', function (t) {
  try { fs.unlinkSync('owner-lock') } catch (er) {}
  try { fs.unlinkSync('basic-lock') } catch (er) {}
  try { fs.unlinkSync('sync-lock') } catch (er) {}
  try { fs.unlinkSync('never-forget') } catch (er) {}
  try { fs.unlinkSync('stale-lock') } catch (er) {}
  try { fs.unlinkSync('watch-lock') } catch (er) {}
  try { fs.unlinkSync('retry-lock') } catch (er) {}
  t.end()
})

test('many locks waiting with watcher', function (t) {
  var gotlocks = 0;
  setTimeout(function() {
    console.log('locks '+gotlocks)
    t.ok(gotlocks === 50)
    t.end();
  }, 1000)

  lockFile.lock('basic-lock', function(er, lock) {
    if (er) throw er;
    setTimeout(function() {
      lock.unlock()
    }, 10)
  })

  for (var i=0; i < 50; i++)
    lockFile.lock('basic-lock', { wait: 10000 }, function(er, lock) {
      if (er) throw er;
      setTimeout(function() {
        lock.unlock()
      }, 10)
      gotlocks++
    })
})

test('lock keying', function (t) {
  lockFile.lock('owner-lock', function(er, lock1) {
    try {
      new LockObject('owner-lock', 'somekey', null)
    } catch(e) {
      t.end();
    }
  })
})

test('basic test', function (t) {
  lockFile.check('basic-lock', function (er, locked) {
    if (er) throw er
    t.notOk(locked)
    lockFile.lock('basic-lock', function (er, lock1) {
      if (er) throw er
      lockFile.lock('basic-lock', function (er, lock2) {
        t.ok(er)
        t.notOk(lock2)
        lockFile.check('basic-lock', function (er, locked) {
          if (er) throw er
          t.ok(locked)
          lock1.unlock(function (er) {
            if (er) throw er
            lockFile.check('basic-lock', function (er, locked) {
              if (er) throw er
              t.notOk(locked)
              t.end()
            })
          })
        })
      })
    })
  })
})

test('sync test', function (t) {
  var locked
  locked = lockFile.checkSync('sync-lock')
  t.notOk(locked)
  var lockObject = lockFile.lockSync('sync-lock')
  locked = lockFile.checkSync('sync-lock')
  t.ok(locked)
  lockObject.unlockSync()
  locked = lockFile.checkSync('sync-lock')
  t.notOk(locked)
  t.end()
})

test('exit cleanup test', function (t) {
  var child = require.resolve('./fixtures/child.js')
  var node = process.execPath
  var spawn = require('child_process').spawn
  spawn(node, [child]).on('exit', function () {
    setTimeout(function () {
      var locked = lockFile.checkSync('never-forget')
      t.notOk(locked)
      t.end()
    }, 100)
  })
})

test('error exit cleanup test', function (t) {
  var child = require.resolve('./fixtures/bad-child.js')
  var node = process.execPath
  var spawn = require('child_process').spawn
  spawn(node, [child]).on('exit', function () {
    setTimeout(function () {
      var locked = lockFile.checkSync('never-forget')
      t.notOk(locked)
      t.end()
    }, 100)
  })
})


test('staleness test', function (t) {
  lockFile.lock('stale-lock', function (er) {
    if (er) throw er

    var opts = { stale: 1 }
    setTimeout(next, 10)
    function next () {
      lockFile.check('stale-lock', opts, function (er, locked) {
        if (er) throw er
        t.notOk(locked)
        lockFile.lock('stale-lock', opts, function (er, lock1) {
          console.log('next2')
          if (er) throw er
          lock1.unlock(function (er) {
            if (er) throw er
            t.end()
          })
        })
      })
    }
  })
})

test('staleness sync test', function (t) {
  var opts = { stale: 1 }
  lockFile.lockSync('stale-lock')
  setTimeout(next, 10)
  function next () {
    var locked
    locked = lockFile.checkSync('stale-lock', opts)
    t.notOk(locked)
    var lock = lockFile.lockSync('stale-lock', opts)
    lock.unlockSync()
    t.end()
  }
})

test('watch test', function (t) {
  var opts = { wait: 100 }
  var fdx
  lockFile.lock('watch-lock', function (er, lock1) {
    if (er) throw er
    setTimeout(unlock, 10)
    function unlock () {
      console.error('unlocking it')
      lock1.unlockSync()
      // open another file, so the fd gets reused
      // so we can know that it actually re-opened it fresh,
      // rather than just getting the same lock as before.
      fdx = fs.openSync('x', 'w')
      fdy = fs.openSync('x', 'w')
    }

    // should have gotten a new fd
    lockFile.lock('watch-lock', opts, function (er, lock2) {
      if (er) throw er
      t.notEqual(lock1.fd, lock2.fd)
      fs.closeSync(fdx)
      fs.closeSync(fdy)
      fs.unlinkSync('x')
      lock2.unlockSync()
      t.end()
    })
  })
})

test('retries', function (t) {
  // next 5 opens will fail.
  var opens = 5
  fs._open = fs.open
  fs.open = function (path, mode, cb) {
    if (--opens === 0) {
      fs.open = fs._open
      return fs.open(path, mode, cb)
    }
    var er = new Error('bogus')
    // to be, or not to be, that is the question.
    er.code = opens % 2 ? 'EEXIST' : 'ENOENT'
    process.nextTick(cb.bind(null, er))
  }

  lockFile.lock('retry-lock', { retries: opens }, function (er, lock) {
    if (er) throw er
    t.equal(opens, 0)
    t.ok(lock)
    lock.unlockSync()
    t.end()
  })
})

test('retryWait', function (t) {
  // next 5 opens will fail.
  var opens = 5
  fs._open = fs.open
  fs.open = function (path, mode, cb) {
    if (--opens === 0) {
      fs.open = fs._open
      return fs.open(path, mode, cb)
    }
    var er = new Error('bogus')
    // to be, or not to be, that is the question.
    er.code = opens % 2 ? 'EEXIST' : 'ENOENT'
    process.nextTick(cb.bind(null, er))
  }

  var opts = { retries: opens, retryWait: 100 }
  lockFile.lock('retry-lock', opts, function (er, lock) {
    if (er) throw er
    t.equal(opens, 0)
    t.ok(lock)
    lock.unlockSync()
    t.end()
  })
})

test('retry sync', function (t) {
  // next 5 opens will fail.
  var opens = 5
  fs._openSync = fs.openSync
  fs.openSync = function (path, mode) {
    if (--opens === 0) {
      fs.openSync = fs._openSync
      return fs.openSync(path, mode)
    }
    var er = new Error('bogus')
    // to be, or not to be, that is the question.
    er.code = opens % 2 ? 'EEXIST' : 'ENOENT'
    throw er
  }

  var opts = { retries: opens }
  var lock = lockFile.lockSync('retry-lock', opts)
  t.ok(lock);
  t.equal(opens, 0)
  lock.unlockSync()
  t.end()
})

test('cleanup', function (t) {
  try { fs.unlinkSync('owner-lock') } catch (er) {}
  try { fs.unlinkSync('basic-lock') } catch (er) {}
  try { fs.unlinkSync('sync-lock') } catch (er) {}
  try { fs.unlinkSync('never-forget') } catch (er) {}
  try { fs.unlinkSync('stale-lock') } catch (er) {}
  try { fs.unlinkSync('watch-lock') } catch (er) {}
  try { fs.unlinkSync('retry-lock') } catch (er) {}
  t.end()
})

