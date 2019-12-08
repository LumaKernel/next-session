/* eslint-disable no-param-reassign */
const crypto = require('crypto');
const { promisify } = require('util');
const MemoryStore = require('./session/memory');
const Store = require('./session/store');
const Cookie = require('./session/cookie');
const Session = require('./session/session');
const { parseToMs } = require('./session/utils');

const genidFn = () => crypto.randomBytes(16).toString('hex');

const hash = (sess) => {
  const str = JSON.stringify(sess, (key, val) => {
    if (key === 'cookie') {
      //  filtered out session.cookie
      return undefined;
    }
    return val;
  });
  //  hash
  return crypto
    .createHash('sha1')
    .update(str, 'utf8')
    .digest('hex');
};

let storeReady = true;

const session = (options = {}) => {
  const name = options.name || 'sessionId';
  const cookieOptions = options.cookie || {};
  const store = options.store || new MemoryStore();
  const genid = options.genid || genidFn;
  const touchAfter = options.touchAfter ? parseToMs(options.touchAfter) : 0;
  const rollingSession = options.rolling || false;

  //  Notify MemoryStore should not be used in production
  //  eslint-disable-next-line no-console
  if (store instanceof MemoryStore) console.warn('MemoryStore should not be used in production environment.');

  //  Promisify callback-based store.
  if (store.get.length > 1) store.get = promisify(store.get);
  if (store.set.length > 2) store.set = promisify(store.set);
  if (store.destroy.length > 2) store.destroy = promisify(store.destroy);
  if (store.touch && store.touch.length > 2) store.touch = promisify(store.touch);

  //  store readiness
  store.on('disconnect', () => {
    storeReady = false;
  });
  store.on('connect', () => {
    storeReady = true;
  });

  return (req, res, next) => {
    /**
     * Modify req and res to "inject" the middleware
     */
    if (req.session) return next();

    //  check for store readiness before proceeded

    if (!storeReady) return next();
    //  TODO: add pathname mismatch check

    //  Expose store
    req.sessionStore = store;

    //  Get sessionId cookie from Next.js parsed req.cookies
    req.sessionId = req.cookies[name];

    const getSession = () => {
      //  Return a session object
      if (!req.sessionId) {
        //  If no sessionId found in Cookie header, generate one
        return Promise.resolve(hash(req.sessionStore.generate(req, genid(), cookieOptions)));
      }
      return req.sessionStore.get(req.sessionId)
        .then((sess) => {
          if (sess) {
            return hash(req.sessionStore.createSession(req, sess));
          }
          return hash(req.sessionStore.generate(req, genid(), cookieOptions));
        });
    };

    return getSession().then((hashedsess) => {
      let sessionSaved = false;
      const oldEnd = res.end;
      let ended = false;
      //  Proxy res.end
      res.end = function resEndProxy(...args) {
        //  If res.end() is called multiple times, do nothing after the first time
        if (ended) {
          return false;
        }
        ended = true;
        //  save session to store if there are changes (and there is a session)
        const saveSession = () => {
          if (req.session) {
            if (hash(req.session) !== hashedsess) {
              sessionSaved = true;
              return req.session.save();
            }
            //  Touch: extend session time despite no modification
            if (req.session.cookie.maxAge && touchAfter >= 0) {
              const minuteSinceTouched = (
                req.session.cookie.maxAge
                  - (req.session.cookie.expires - new Date())
              );
              if ((minuteSinceTouched < touchAfter)) {
                return Promise.resolve();
              }
              return req.session.touch();
            }
          }
          return Promise.resolve();
        };

        return saveSession()
          .then(() => {
            if (
              (req.cookies[name] !== req.sessionId || sessionSaved || rollingSession)
                && req.session
            ) {
              res.setHeader('Set-Cookie', req.session.cookie.serialize(name, req.sessionId));
            }

            oldEnd.apply(this, args);
          });
      };

      next();
    });
  };
};

module.exports = session;
module.exports.Store = Store;
module.exports.Cookie = Cookie;
module.exports.Session = Session;
module.exports.MemoryStore = MemoryStore;
