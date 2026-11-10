/* Project Board – Firebase connection layer.
   Shared by index.html and setup.html. Needs firebase-config.js loaded first. */
(function(){
  var PB = window.PB = {ready: false, error: ''};
  var cfg = window.FIREBASE_CONFIG;
  if (typeof firebase === 'undefined') { PB.error = 'Could not load Firebase. Check the internet connection and reload.'; return; }
  if (!cfg || !cfg.apiKey || /PASTE|YOUR_/i.test(cfg.apiKey)) { PB.error = 'The board is not configured yet: fill in firebase-config.js.'; return; }

  var app = firebase.initializeApp(cfg);
  var db = app.firestore();
  try { db.settings({ignoreUndefinedProperties: true}); } catch (e) {}
  var auth = app.auth();
  /* A sign-in lasts until the browser tab is closed, as before. */
  auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(function(){});

  /* Sign-in emails are internal ids, never real addresses; people sign in with their username. */
  var EMAIL_DOMAIN = 'example.com';
  function rand(n){
    var a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function makeEmail(user){
    var base = String(user).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'user';
    return base + '-' + rand(5) + '@' + EMAIL_DOMAIN;
  }

  /* Resolves true on success, false for a wrong username or password; rejects on other trouble. */
  function signIn(user, passHash){
    return db.doc('logins/' + user).get().then(function(snap){
      if (!snap.exists || !snap.data().email) return false;
      return auth.signInWithEmailAndPassword(snap.data().email, passHash).then(function(){ return true; }, function(err){
        var c = err && err.code || '';
        if (/wrong-password|user-not-found|invalid-credential|invalid-login-credentials|user-disabled|invalid-email/.test(c)) return false;
        if (c === 'auth/too-many-requests') throw {code: 'too-many-requests'};
        throw err;
      });
    });
  }

  /* Waits for Firebase to report the saved session, then returns the username it belongs to (or ''). */
  function restore(){
    return new Promise(function(resolve){
      var off = auth.onAuthStateChanged(function(u){
        off();
        if (!u) { resolve(''); return; }
        db.doc('uids/' + u.uid).get().then(function(s){ resolve(s.exists ? s.data().user : ''); }, function(){ resolve(''); });
      });
    });
  }

  /* Makes a new Firebase login without signing the admin out (a second, temporary app instance). */
  var second = null;
  function createLogin(user, passHash){
    if (!second) {
      second = firebase.initializeApp(cfg, 'pb-second');
      second.auth().setPersistence(firebase.auth.Auth.Persistence.NONE).catch(function(){});
    }
    var email = makeEmail(user);
    return second.auth().createUserWithEmailAndPassword(email, passHash).then(function(cred){
      var uid = cred.user.uid;
      return second.auth().signOut().then(function(){ return {uid: uid, email: email}; });
    });
  }

  /* ---------- attachments, stored in Firestore in pieces (works on the free plan) ---------- */
  var MAX_FILE = 5 * 1024 * 1024;
  var PART = 700000; /* base64 characters per piece, under the 1 MB document limit */
  function isStoredFile(f){ return !!(f && typeof f.url === 'string' && f.url.indexOf('fsfile:') === 0); }
  function readBase64(file){
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){ var s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function(){ reject(r.error); };
      r.readAsDataURL(file);
    });
  }
  function upload(file, owner){
    if (file.size > MAX_FILE) return Promise.reject({code: 'file-too-large (max 5 MB)'});
    var id = Date.now().toString(36) + rand(6);
    return readBase64(file).then(function(b64){
      var parts = [];
      for (var i = 0; i < b64.length; i += PART) parts.push(b64.slice(i, i + PART));
      if (!parts.length) parts.push('');
      var chain = Promise.resolve();
      parts.forEach(function(p, i){
        chain = chain.then(function(){ return db.doc('files/' + id + '/parts/p' + ('00' + i).slice(-3)).set({d: p, owner: owner}); });
      });
      return chain.then(function(){
        return db.doc('files/' + id).set({name: file.name, type: file.type || 'application/octet-stream', size: file.size, parts: parts.length, owner: owner, at: Date.now()});
      }).then(function(){ return {id: id, url: 'fsfile:' + id, sizeBytes: file.size}; });
    });
  }
  function openFile(id, name){
    return db.doc('files/' + id).get().then(function(meta){
      if (!meta.exists) throw {code: 'missing'};
      var m = meta.data();
      return db.collection('files/' + id + '/parts').get().then(function(snap){
        var docs = snap.docs.slice().sort(function(a, b){ return a.id < b.id ? -1 : 1; });
        var b64 = docs.map(function(d){ return d.data().d || ''; }).join('');
        var bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return save({filename: name || m.name, data: new Blob([bytes], {type: m.type})});
      });
    });
  }

  /* ---------- downloads ---------- */
  function save(o){
    return new Promise(function(resolve){
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], {type: /\.csv$/i.test(o.filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = o.filename; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); resolve(); }, 1500);
    });
  }

  PB.ready = true;
  PB.app = app; PB.db = db; PB.auth = auth;
  PB.signIn = signIn; PB.restore = restore; PB.createLogin = createLogin;
  PB.isStoredFile = isStoredFile; PB.openFile = openFile;
  PB.files = {upload: upload};
  PB.downloads = {save: save};
})();
