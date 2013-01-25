var fs = require('fs')

var wx = 'wx'
if (process.version.match(/^v0.[456]/)) {
  var c = require('constants')
  wx = c.O_TRUNC | c.O_CREAT | c.O_WRONLY | c.O_EXCL
}

function LockObject(path, fd) {
  this.path = path
  this.fd = fd;

  if (locks[path])
    throw new Error('lock already taken as '+locks[path])

  this._locked = true;

  locks[path] = this
}

LockObject.prototype.unlock_ = function() {
  if (!this._locked)
    return

  if (!locks[this.path] || locks[this.path] !== this)
    throw new Error('attempted to unlock wrong lock ', locks[this.path])

  this._locked = false
}

LockObject.prototype.unlock = function(cb) {
  var that = this

  this.unlock_()

  fs.unlink(this.path, function (unlinkEr) {
    delete locks[that.path]
    fs.close(that.fd, function (closeEr) {
      if (cb) cb()
    })
  })
};

LockObject.prototype.unlockSync = function() {
  this.unlock_()

  try { fs.unlinkSync(this.path) } catch (er) {}
  delete locks[this.path]
  try { fs.close(this.fd) } catch (er) {}
};

exports.LockObject = LockObject

var locks = {}

function cleanup() {
  Object.keys(locks).forEach(function(path) {
    locks[path].unlockSync()
  })
}

process.on('exit', cleanup)

// XXX https://github.com/joyent/node/issues/3555
// Remove when node 0.8 is deprecated.
process.on('uncaughtException', function H (er) {
  var l = process.listeners('uncaughtException').filter(function (h) {
    return h !== H
  })
  if (!l.length) {
    // cleanup
    cleanup()
    process.removeListener('uncaughtException', H)
    throw er
  }
})

function forceUnlock(path, cb) {
  if (locks[path])
    return locks[path].unlock(cb)

  fs.unlink(path, function (unlinkEr) {
      if (cb) cb()
  })
}

function forceUnlockSync(path) {
  if (locks[path])
    return locks[path].unlockSync()

  try { fs.unlinkSync(path) } catch (er) {}
}

exports.check = function (path, opts, cb) {
  if (typeof opts === 'function') cb = opts, opts = {}
  fs.open(path, 'r', function (er, fd) {
    if (er) {
      if (er.code !== 'ENOENT') return cb(er)
      return cb(null, false)
    }

    if (!opts.stale) {
      return fs.close(fd, function (er) {
        return cb(er, true)
      })
    }

    fs.fstat(fd, function (er, st) {
      if (er) return fs.close(fd, function (er2) {
        return cb(er)
      })

      fs.close(fd, function (er) {
        var age = Date.now() - st.ctime.getTime()
        return cb(er, age <= opts.stale)
      })
    })
  })
}

exports.checkSync = function (path, opts) {
  opts = opts || {}
  if (opts.wait) {
    throw new Error('opts.wait not supported sync for obvious reasons')
  }

  try {
    var fd = fs.openSync(path, 'r')
  } catch (er) {
    if (er.code !== 'ENOENT') throw er
    return false
  }

  if (!opts.stale) {
    fs.closeSync(fd)
    return true
  }

  // file exists.  however, might be stale
  if (opts.stale) {
    try {
      var st = fs.fstatSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    var age = Date.now() - st.ctime.getTime()
    return (age <= opts.stale)
  }
}

exports.lock = function (path, opts, cb) {
  if (typeof opts === 'function') cb = opts, opts = {}

  if (typeof opts.retries === 'number' && opts.retries > 0) {
    cb = (function (orig) { return function (er, fd) {
      if (!er) return orig(er, fd)
      var newRT = opts.retries - 1
      opts_ = Object.create(opts, { retries: { value: newRT }})
      if (opts.retryWait) setTimeout(function() {
        exports.lock(path, opts_, orig)
      }, opts.retryWait)
      else exports.lock(path, opts_, orig)
    }})(cb)
  }

  // try to engage the lock.
  // if this succeeds, then we're in business.
  fs.open(path, wx, function (er, fd) {
    if (!er) {
      return cb(null, new LockObject(path, fd));
    }

    // something other than "currently locked"
    // maybe eperm or something.
    if (er.code !== 'EEXIST') return cb(er)

    // someone's got this one.  see if it's valid.
    if (opts.stale) fs.stat(path, function (er, st) {
      if (er) {
        if (er.code === 'ENOENT') {
          // expired already!
          var opts_ = Object.create(opts, { stale: { value: false }})
          exports.lock(path, opts_, cb)
          return
        }
        return cb(er)
      }

      var age = Date.now() - st.ctime.getTime()
      if (age > opts.stale) {
        forceUnlock(path, function (er) {
          if (er) return cb(er)
          var opts_ = Object.create(opts, { stale: { value: false }})
          exports.lock(path, opts_, cb)
        })
      } else notStale(er, path, opts, cb)
    })
    else notStale(er, path, opts, cb)
  })
}

function notStale (er, path, opts, cb) {
  if (typeof opts.wait === 'number' && opts.wait > 0) {
    // wait for some ms for the lock to clear
    var start = Date.now()

    var retried = false
    function retry () {
      if (retried) return
      retried = true
      // maybe already closed.
      try { watcher.close() } catch (e) {}
      clearTimeout(timer)
      var newWait = Date.now() - start
      exports.lock(path, opts, cb)
    }

    try {
      var watcher = fs.watch(path, function (change) {
        if (change === 'rename') {
          // ok, try and get it now.
          // if this fails, then continue waiting, maybe.
          retry()
        }
      })
      watcher.on('error', function (er) {
        // usually means it expired before the watcher spotted it
        retry()
      })
    } catch (er) {
      retry()
    }

    var timer = setTimeout(function () {
      try { watcher.close() } catch (e) {}
      cb(er)
    }, opts.wait)
  } else {
    // failed to lock!
    return cb(er)
  }
}

exports.lockSync = function (path, opts) {
  opts = opts || {}
  if (opts.wait || opts.retryWait) {
    throw new Error('opts.wait not supported sync for obvious reasons')
  }

  try {
    var fd = fs.openSync(path, wx)
    return new LockObject(path, fd)
  } catch (er) {
    if (er.code !== 'EEXIST') return retryThrow(path, opts, er)

    if (opts.stale) {
      var st = fs.statSync(path)
      var age = Date.now() - st.ctime.getTime()
      if (age > opts.stale) {
        forceUnlockSync(path)
        return exports.lockSync(path, opts)
      }
    }

    // failed to lock!
    return retryThrow(path, opts, er)
  }
}

function retryThrow (path, opts, er) {
  if (typeof opts.retries === 'number' && opts.retries > 0) {
    var newRT = opts.retries - 1
    var opts_ = Object.create(opts, { retries: { value: newRT }})
    return exports.lockSync(path, opts_)
  }
  throw er
}

