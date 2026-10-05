/* IndexedDB is the durable merge base; storage.local is only a bounded hot cache. */
(() => {
  const NAME = 'grid-glry-media-indexes';
  const STORE = 'roots';

  function open() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable')); return; }
      const request = indexedDB.open(NAME, 1);
      const timer = setTimeout(() => reject(new Error('GRID index database open timed out')), 5000);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error || new Error('GRID index database could not open')); };
      request.onblocked = () => { clearTimeout(timer); reject(new Error('GRID index database upgrade is blocked')); };
    });
  }

  async function read(folder) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(folder);
        let value;
        request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error ||
          new Error('GRID index database read failed'));
      });
    } finally { db.close(); }
  }

  async function write(folder, record) {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(record, folder);
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error ||
          new Error('GRID index database write failed'));
      });
    } finally { db.close(); }
  }

  globalThis.GRIDMediaIndexStore = { read, write };
})();
