// Shared Firestore + Storage mock factory used across test suites.

function makeFirestoreMock(docData) {
  const docs = Object.assign({}, docData || {});

  const docRef = function(path) {
    return {
      get: jest.fn(function() {
        return Promise.resolve({
          exists: path in docs,
          data: function() { return docs[path]; },
        });
      }),
      set: jest.fn(function(data) {
        docs[path] = data;
        return Promise.resolve();
      }),
      update: jest.fn(function(data) {
        docs[path] = Object.assign({}, docs[path] || {}, data);
        return Promise.resolve();
      }),
      delete: jest.fn(function() {
        delete docs[path];
        return Promise.resolve();
      }),
    };
  };

  return {
    collection: jest.fn(function() {
      return {
        doc: jest.fn(function(id) { return docRef(id); }),
        add: jest.fn(function(data) {
          const id = 'auto-' + Date.now();
          docs[id] = data;
          return Promise.resolve({ id: id });
        }),
        get: jest.fn(function() {
          return Promise.resolve({
            docs: Object.keys(docs).map(function(id) {
              return { id: id, data: function() { return docs[id]; }, exists: true };
            }),
          });
        }),
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
