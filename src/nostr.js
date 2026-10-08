import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { nsecEncode, decode } from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'

const RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nostr.mom',
]

// One replaceable event per hold, d-tag = hold id. Content is NIP-44
// encrypted to our own key so relays only ever see ciphertext.
const HOLD_KIND = 30078
const APP_TAG = 'calfraises'
const NSEC_KEY = 'calf-raises-nsec'

let secretKey = null
let pubkey = null
let conversationKey = null
let pool = null
let activeSub = null

function setKey(sk) {
  secretKey = sk
  pubkey = getPublicKey(sk)
  conversationKey = nip44.getConversationKey(sk, pubkey)
}

export function initKey() {
  const stored = localStorage.getItem(NSEC_KEY)
  if (stored) {
    try {
      const { type, data } = decode(stored)
      if (type === 'nsec') {
        setKey(data)
        return stored
      }
    } catch { /* fall through to generate */ }
  }
  const sk = generateSecretKey()
  setKey(sk)
  const nsec = nsecEncode(sk)
  localStorage.setItem(NSEC_KEY, nsec)
  return nsec
}

export function importNsec(nsecStr) {
  try {
    const { type, data } = decode(nsecStr.trim())
    if (type !== 'nsec') return false
    setKey(data)
    localStorage.setItem(NSEC_KEY, nsecStr.trim())
    return true
  } catch {
    return false
  }
}

export function getNsec() {
  return localStorage.getItem(NSEC_KEY) || ''
}

// Subscribe to our stored holds. onEvent receives
// { id, createdAt, deleted, hold } with the payload already decrypted.
export function connect(onEvent, onEose) {
  disconnect()
  pool = new SimplePool()

  activeSub = pool.subscribeMany(
    RELAYS,
    { kinds: [HOLD_KIND], authors: [pubkey], '#t': [APP_TAG] },
    {
      onevent(event) {
        const id = event.tags.find(t => t[0] === 'd')?.[1]
        if (!id) return
        if (event.tags.some(t => t[0] === 'deleted' && t[1] === 'true') || !event.content) {
          onEvent({ id, createdAt: event.created_at, deleted: true })
          return
        }
        try {
          const hold = JSON.parse(nip44.decrypt(event.content, conversationKey))
          onEvent({ id, createdAt: event.created_at, deleted: false, hold })
        } catch (e) {
          console.warn('[NOSTR] could not decrypt event', event.id.slice(0, 8), e)
        }
      },
      oneose() {
        onEose()
      },
    }
  )
}

export function disconnect() {
  if (activeSub) { activeSub.close(); activeSub = null }
  if (pool) { pool.close(RELAYS); pool = null }
}

async function publish(tags, content) {
  if (!secretKey || !pool) throw new Error('NOSTR not initialised')
  const event = finalizeEvent(
    { kind: HOLD_KIND, created_at: Math.floor(Date.now() / 1000), tags, content },
    secretKey
  )
  const results = await Promise.allSettled(pool.publish(RELAYS, event))
  if (!results.some(r => r.status === 'fulfilled')) throw new Error('All relays rejected the event')
}

export function publishHold(entry) {
  const { id, leg, session, duration, ts } = entry
  const payload = JSON.stringify({ leg, session, duration, ts })
  return publish([['d', id], ['t', APP_TAG]], nip44.encrypt(payload, conversationKey))
}

export function tombstoneHold(id) {
  return publish([['d', id], ['t', APP_TAG], ['deleted', 'true']], '')
}
