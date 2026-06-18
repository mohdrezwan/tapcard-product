// Shared Firestore + Storage mock factory used across test suites.

function makeFirestoreMock(docData) {
  let autoId = 0;
  const docs = Object.assign({}, docData || {});

  // collectionName prefix prevents key collision between collection().doc() and db.doc()
  const docRef = function(key) {
    return {
      get: jest.fn(function() {
        return Promise.resolve({
          exists: key in docs,
          data: function() { return docs[key]; },
        });
      }),
      set: jest.fn(function(data) {
        docs[key] = data;
        return Promise.resolve();
      }),
      update: jest.fn(function(data) {
        docs[key] = Object.assign({}, docs[key] || {}, data);
        return Promise.resolve();
      }),
      delete: jest.fn(function() {
        delete docs[key];
        return Promise.resolve();
      }),
    };
  };

  return {
    collection: jest.fn(function(collName) {
      return {
        doc: jest.fn(function(id) { return docRef(collName + '/' + id); }),
        add: jest.fn(function(data) {
          const id = 'auto-' + (++autoId);
          docs[collName + '/' + id] = data;
          return Promise.resolve({ id: id });
        }),
        get: jest.fn(function() {
          const prefix = collName + '/';
          return Promise.resolve({
            docs: Object.keys(docs)
              .filter(function(k) { return k.startsWith(prefix); })
              .map(function(k) {
                return { id: k.slice(prefix.length), data: function() { return docs[k]; }, exists: true };
              }),
          });
        }),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
      };
    }),
    doc: jest.fn(function(path) { return docRef(path); }),
    _docs: docs,
  };
}

function makeStorageMock() {
  const files = {};
  const mockFile = function(name) {
    return {
      save: jest.fn(function(buf, opts) {
        files[name] = { buf: buf, opts: opts };
        return Promise.resolve();
      }),
      makePublic: jest.fn(function() { return Promise.resolve(); }),
      publicUrl: function() { return 'https://storage.example.com/' + name; },
    };
  };

  return {
    bucket: jest.fn(function() {
      return { file: jest.fn(function(name) { return mockFile(name); }) };
    }),
    _files: files,
  };
}

module.exports = { makeFirestoreMock: makeFirestoreMock, makeStorageMock: makeStorageMock };
