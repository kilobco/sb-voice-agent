// supabaseClient.js
// Handles all Supabase DB operations for call records and orders.
//
// Call lifecycle:
//   createCallRecord()    → when Twilio call connects      (status: in_progress)
//   completeCallRecord()  → when call ends normally        (status: completed)
//   escalateCallRecord()  → when call is transferred       (status: escalated)
//   failCallRecord()      → when call drops unexpectedly   (status: failed)
//
// Order lifecycle:
//   writeOrder()          → when AI confirms a completed order

'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Client setup — lazy singleton so the module can be imported in tests
// without real env vars
// ---------------------------------------------------------------------------
let _supabase = null;

function getClient() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  }
  _supabase = createClient(url, key);
  return _supabase;
}

// Exposed for testing — lets tests inject a mock client
function _setClient(mockClient) {
  _supabase = mockClient;
}

const getRestaurantId = () => {
  const id = process.env.DEFAULT_RESTAURANT_ID;
  if (!id) throw new Error('Missing DEFAULT_RESTAURANT_ID environment variable');
  return id;
};

// Texas sales tax rate
const TX_TAX_RATE = 0.0825;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a Supabase operation. Throws on error so callers can use try/catch.
 * @param {string} operation - human-readable name for logging
 * @param {{ data, error }} result - destructured Supabase response
 */
function handleResult(operation, { data, error }) {
  if (error) {
    const msg = `[supabaseClient] ${operation} failed: ${error.message}`;
    console.error(msg);
    throw new Error(msg);
  }
  return data;
}

/**
 * Calculates call duration in seconds from a start timestamp to now.
 * @param {string|Date} startedAt
 * @returns {number}
 */
function calcDurationSeconds(startedAt) {
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
}

/**
 * Calculates order total including Texas sales tax.
 * @param {Array<{price: number, quantity: number}>} cartItems
 * @returns {number} total rounded to 2 decimal places
 */
function calcOrderTotal(cartItems) {
  const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(subtotal * (1 + TX_TAX_RATE) * 100) / 100;
}

// ---------------------------------------------------------------------------
// CALL RECORDS
// ---------------------------------------------------------------------------

/**
 * Creates a call record when a Twilio call connects.
 * Called by the telephony layer when the media stream starts.
 *
 * @param {string} callSid         - Twilio CallSid (unique per call)
 * @param {string} streamSid       - Twilio MediaStream SID
 * @param {string} callerPhone     - caller's E.164 phone number
 * @param {string} restaurantPhone - restaurant's E.164 phone number
 * @returns {Promise<object>}      - the inserted call row
 * @throws if the insert fails
 */
async function createCallRecord(callSid, streamSid, callerPhone, restaurantPhone) {
  if (!callSid)        throw new TypeError('createCallRecord: callSid is required');
  if (!callerPhone)    throw new TypeError('createCallRecord: callerPhone is required');
  if (!restaurantPhone) throw new TypeError('createCallRecord: restaurantPhone is required');

  const db = getClient();
  const result = await db.from('calls').insert({
    restaurant_id:     getRestaurantId(),
    twilio_call_sid:   callSid,
    twilio_stream_sid: streamSid || null,
    caller_phone:      callerPhone,
    restaurant_phone:  restaurantPhone,
    status:            'in_progress',
    started_at:        new Date().toISOString(),
  }).select().single();

  const data = handleResult('createCallRecord', result);
  console.log(`[supabaseClient] Call started: ${callSid} | caller: ${callerPhone}`);
  return data;
}

/**
 * Marks a call as completed when it ends normally.
 * Calculates duration from the original started_at timestamp.
 *
 * @param {string} callSid   - Twilio CallSid
 * @param {string} startedAt - ISO timestamp from the call record
 * @returns {Promise<void>}
 * @throws if the update fails
 */
async function completeCallRecord(callSid, startedAt) {
  if (!callSid)   throw new TypeError('completeCallRecord: callSid is required');
  if (!startedAt) throw new TypeError('completeCallRecord: startedAt is required');

  const db = getClient();
  const result = await db.from('calls').update({
    status:           'completed',
    ended_at:         new Date().toISOString(),
    duration_seconds: calcDurationSeconds(startedAt),
  }).eq('twilio_call_sid', callSid);

  handleResult('completeCallRecord', result);
  console.log(`[supabaseClient] Call completed: ${callSid}`);
}

/**
 * Marks a call as escalated when transferred to a human agent.
 *
 * @param {string} callSid - Twilio CallSid
 * @returns {Promise<void>}
 * @throws if the update fails
 */
async function escalateCallRecord(callSid) {
  if (!callSid) throw new TypeError('escalateCallRecord: callSid is required');

  const db = getClient();
  const result = await db.from('calls').update({
    status:   'escalated',
    ended_at: new Date().toISOString(),
  }).eq('twilio_call_sid', callSid);

  handleResult('escalateCallRecord', result);
  console.log(`[supabaseClient] Call escalated: ${callSid}`);
}

/**
 * Marks a call as failed when it drops unexpectedly (network error, etc.).
 * Not in the original sample — added to cover the missing failure path.
 *
 * @param {string} callSid - Twilio CallSid
 * @param {string} [reason] - optional reason string for debugging
 * @returns {Promise<void>}
 * @throws if the update fails
 */
async function failCallRecord(callSid, reason) {
  if (!callSid) throw new TypeError('failCallRecord: callSid is required');

  const db = getClient();
  const result = await db.from('calls').update({
    status:   'failed',
    ended_at: new Date().toISOString(),
    ...(reason ? { failure_reason: reason } : {}),
  }).eq('twilio_call_sid', callSid);

  handleResult('failCallRecord', result);
  console.log(`[supabaseClient] Call failed: ${callSid}${reason ? ` | reason: ${reason}` : ''}`);
}

// ---------------------------------------------------------------------------
// ORDERS
// ---------------------------------------------------------------------------

/**
 * Writes a complete order when the AI finishes taking an order.
 * Steps: upsert customer → insert order → insert order_items (batch).
 * Called by Peter 3 via the bridge when the completeOrder tool fires.
 *
 * @param {string} callId        - UUID of the call record (calls.id)
 * @param {string} customerName  - customer's display name
 * @param {string} phoneNumber   - customer's E.164 phone number
 * @param {Array}  cartItems     - array of cart items:
 *   { itemName: string, quantity: number, price: number, notes?: string }
 * @returns {Promise<{ orderId: string, total: number, customerId: string }>}
 * @throws if any DB step fails
 */
async function writeOrder(callId, customerName, phoneNumber, cartItems) {
  if (!callId)                  throw new TypeError('writeOrder: callId is required');
  if (!customerName)            throw new TypeError('writeOrder: customerName is required');
  if (!phoneNumber)             throw new TypeError('writeOrder: phoneNumber is required');
  if (!Array.isArray(cartItems)) throw new TypeError('writeOrder: cartItems must be an array');
  if (cartItems.length === 0)   throw new RangeError('writeOrder: cartItems must not be empty');

  // Validate each cart item
  for (let i = 0; i < cartItems.length; i++) {
    const item = cartItems[i];
    if (!item.itemName)                throw new TypeError(`writeOrder: cartItems[${i}].itemName is required`);
    if (typeof item.quantity !== 'number' || item.quantity < 1)
                                       throw new TypeError(`writeOrder: cartItems[${i}].quantity must be a positive number`);
    if (typeof item.price !== 'number' || item.price < 0)
                                       throw new TypeError(`writeOrder: cartItems[${i}].price must be a non-negative number`);
  }

  const db = getClient();

  // 1. Upsert customer — match on phone_number; update name if it changed
  const customerResult = await db.from('customers')
    .upsert(
      { phone_number: phoneNumber, name: customerName },
      { onConflict: 'phone_number' }
    )
    .select()
    .single();
  const customer = handleResult('writeOrder:upsertCustomer', customerResult);

  // 2. Calculate total with Texas sales tax
  const total = calcOrderTotal(cartItems);

  // 3. Insert order header
  const orderResult = await db.from('orders').insert({
    restaurant_id: getRestaurantId(),
    customer_id:   customer.id,
    call_id:       callId,
    status:        'confirmed',
    total_amount:  total,
  }).select().single();
  const order = handleResult('writeOrder:insertOrder', orderResult);

  // 4. Batch-insert order items
  const orderItemsResult = await db.from('order_items').insert(
    cartItems.map(item => ({
      order_id:       order.id,
      item_name:      item.itemName,
      quantity:       item.quantity,
      unit_price:     item.price,
      customizations: item.notes ? { notes: item.notes } : {},
    }))
  );
  handleResult('writeOrder:insertOrderItems', orderItemsResult);

  console.log(`[supabaseClient] Order written: ${order.id} | total: $${total} | items: ${cartItems.length}`);
  return { orderId: order.id, total, customerId: customer.id };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  createCallRecord,
  completeCallRecord,
  escalateCallRecord,
  failCallRecord,
  writeOrder,
  // Internal helpers exported for testing and potential reuse
  _setClient,
  _calcDurationSeconds: calcDurationSeconds,
  _calcOrderTotal:      calcOrderTotal,
};