// orderManager.js
// In-memory cart state per call + Supabase writes on order completion.
// Each call gets its own session keyed by callSid.
// When the call ends, the session is deleted.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

// Lazy Supabase client — only initialised when completeOrder fires.
// This lets the Gemini session run and be tested without Supabase credentials.
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.startsWith('peter2')) {
      throw new Error('SUPABASE_URL is not set. Ask Peter 2 for the Supabase values.');
    }
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

const RESTAURANT_ID = process.env.DEFAULT_RESTAURANT_ID;
const TAX_RATE = 0.0825; // Texas 8.25%

// In-memory sessions: callSid → { callDbId, cart, startedAt }
const sessions = new Map();

// ── Called by geminiSession.js when the call connects ─────────────────────

function createSession(callSid, callDbId) {
  sessions.set(callSid, {
    callDbId,
    cart: [],
    startedAt: new Date()
  });
  console.log(`Session created for call: ${callSid}`);
}

function getSession(callSid) {
  return sessions.get(callSid);
}

// ── Called when Gemini fires the manageOrder tool ─────────────────────────

function handleManageOrder(callSid, args) {
  const session = sessions.get(callSid);
  if (!session) return { result: 'Error: session not found' };

  const { action, itemName, quantity, price, notes } = args;

  if (action === 'add') {
    // If item already in cart, update quantity instead of duplicating
    const existing = session.cart.find(i => i.itemName === itemName);
    if (existing) {
      existing.quantity = quantity;
      existing.notes = notes || existing.notes;
    } else {
      session.cart.push({ itemName, quantity, price, notes: notes || '' });
    }
    console.log(`Cart [${callSid}]: Added ${quantity}x ${itemName} @ $${price}`);
  } else if (action === 'remove') {
    session.cart = session.cart.filter(i => i.itemName !== itemName);
    console.log(`Cart [${callSid}]: Removed ${itemName}`);
  }

  // Log current cart state after every change
  const subtotal = session.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  console.log(`Cart subtotal: $${subtotal.toFixed(2)} | Items: ${session.cart.length}`);

  return { result: 'Cart updated successfully.' };
}

// ── Called when Gemini fires the completeOrder tool ───────────────────────
// This is the big one — writes customer, order, and order_items to Supabase.

async function handleCompleteOrder(callSid, args) {
  const session = sessions.get(callSid);
  if (!session) return { result: 'Error: session not found', orderId: null };

  const { customerName, phoneNumber } = args;
  const { callDbId, cart } = session;

  if (cart.length === 0) {
    return { result: 'Error: cart is empty', orderId: null };
  }

  try {
    const supabase = getSupabase();

    // 1. Upsert customer by phone number (avoids duplicate customers)
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .upsert(
        { phone_number: phoneNumber, name: customerName },
        { onConflict: 'phone_number' }
      )
      .select()
      .single();

    if (custErr) console.error('Customer upsert error:', custErr.message);

    // 2. Calculate totals
    const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const total = Math.round(subtotal * (1 + TAX_RATE) * 100) / 100;

    // 3. Insert order row
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        restaurant_id: RESTAURANT_ID,
        customer_id: customer?.id || null,
        call_id: callDbId,
        status: 'confirmed',
        total_amount: total
      })
      .select()
      .single();

    if (orderErr) {
      console.error('Order insert error:', orderErr.message);
      return { result: 'Error writing order to database', orderId: null };
    }

    // 4. Insert one row per cart item into order_items
    const orderItems = cart.map(item => ({
      order_id: order.id,
      item_name: item.itemName,
      quantity: item.quantity,
      unit_price: item.price,
      customizations: item.notes ? { notes: item.notes } : {}
    }));

    const { error: itemsErr } = await supabase
      .from('order_items')
      .insert(orderItems);

    if (itemsErr) console.error('Order items error:', itemsErr.message);

    // 5. Generate human-readable order number from UUID
    const orderNumber = 'SB-IRV-' + order.id.substring(0, 6).toUpperCase();

    console.log(`✓ Order confirmed: ${orderNumber} | Total: $${total} | Customer: ${customerName}`);

    // 6. Clear cart after successful order
    session.cart = [];

    return {
      result: `Order confirmed successfully. Order number is ${orderNumber}.`,
      orderId: order.id,
      orderNumber,
      total
    };
  } catch (err) {
    console.error('handleCompleteOrder error:', err.message);
    return {
      result: 'There was an error confirming your order. Please try again.',
      orderId: null
    };
  }
}

// ── Called by geminiSession.js when the call ends ─────────────────────────

function deleteSession(callSid) {
  sessions.delete(callSid);
  console.log(`Session deleted for call: ${callSid}`);
}

module.exports = {
  createSession,
  getSession,
  handleManageOrder,
  handleCompleteOrder,
  deleteSession
};