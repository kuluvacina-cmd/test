import type { StoredLibrary } from '../types'

const DATABASE = 'song-library'
const STORE = 'library'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Trình duyệt không mở được bộ nhớ cục bộ.'))
  })
}

export async function readLibrary(): Promise<StoredLibrary | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get('current')
    request.onsuccess = () => {
      const value = request.result as StoredLibrary | undefined
      resolve(value?.version === 1 && Array.isArray(value.tracks) ? value : null)
    }
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => db.close()
  })
}

export async function writeLibrary(library: StoredLibrary): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(library, 'current')
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error) }
    transaction.onabort = () => { db.close(); reject(transaction.error) }
  })
}
