// orderManager.js
// In-memory cart state per call + Supabase writes on order completion.
// Each call gets its own session keyed by callSid.
// When the call ends, the session is deleted.
//
// Red Team #19 — dotenv removed. geminiSession.js (the entry point) loads it.
// process.env is shared across all requires — no need to call config() here.

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

// ── Red Team #12 — PRICE_MAP ─────────────────────────────────────────────────
// Authoritative prices from the menu. handleManageOrder overrides whatever
// price Gemini hallucinates with the correct value from this map.
// Keys must match itemName exactly as Gemini will call them (menu names).

const PRICE_MAP = {
  // APPETIZERS
  'Rasam': 6.99,
  'Rava Kichadi': 8.75,
  'Thatte Idly': 7.49,
  'Idly (2)': 8.49,
  'Idly (1) & Vada (1)': 8.99,
  'Rasa Vada (2)': 8.49,
  'Sambar Vada (2)': 8.99,
  'Medhu Vada (2)': 9.49,
  'Masala Vada (3)': 8.49,
  'Curd Vada (2)': 10.49,
  'Mysore Bonda (3)': 8.99,
  'Ghee Podi Thatte Idly': 9.49,
  '14 Pcs Mini Ghee Sambar Idly': 9.99,
  'Ghee Pongal': 10.49,
  'Kaima Idly': 12.99,
  // EVENING SPECIALS
  'Chilli Bajji (2)': 8.49,
  'Onion Bajji (3)': 7.99,
  'Plantain Bajji (2)': 7.99,
  'Vegetable Bonda (3)': 7.99,
  // DOSAS
  'Plain Dosa': 9.99,
  'Onion Dosa': 9.99,
  'Masala Dosa': 11.49,
  'Onion Masala Dosa': 10.99,
  'Onion Chilli Dosa': 10.49,
  'Onion Chilli Masala Dosa': 10.99,
  'Kara Dosa': 12.99,
  'Kesari Dosa': 11.49,
  'Milagaipodi Dosa': 11.99,
  'Milagaipodi Masala Dosa': 12.49,
  'Mysore Dosa': 12.49,
  'Mysore Masala Dosa': 12.99,
  'Mysore Onion Dosa': 13.49,
  'Mysore Onion Masala Dosa': 13.99,
  'Rava Dosa': 10.49,
  'Rava Masala Dosa': 10.99,
  'Onion Rava Dosa': 11.49,
  'Onion Rava Masala Dosa': 13.49,
  'Onion Chilli Rava Dosa': 11.99,
  'Onion Chilli Rava Masala Dosa': 13.49,
  'Ghee Rava Dosa': 12.99,
  'Ghee Rava Masala Dosa': 13.49,
  'Ghee Onion Rava Dosa': 13.49,
  'Ghee Onion Rava Masala Dosa': 13.99,
  'Dry Fruit Rava Dosa': 12.99,
  'Dry Fruit Rava Masala Dosa': 13.49,
  'Cheese Dosa': 12.49,
  'Cheese Masala Dosa': 12.99,
  'Cheese Kara Dosa': 12.99,
  'Cheese Podi Masala Dosa': 13.49,
  'Vegetable Dosa': 11.99,
  'Paper Roast': 11.49,
  'Paper Roast Masala': 11.99,
  'Kal Dosa': 14.49,
  'Pesarattu Dosa': 13.99,
  'Pesarat Upma': 14.99,
  'Saravana Special Dosa': 13.99,
  'Benne Masala Dosa': 12.99,
  'Benne Dosa': 16.75,
  // MORE SPECIAL DOSAS
  'Onion Podi Dosa': 12.99,
  'Podi Kara Dosa': 11.99,
  'Onion Rava Kara Masala Dosa': 13.99,
  'Spring Dosa': 13.99,
  'Pav Bhaji Dosa': 13.99,
  'Sandwich Dosa': 15.99,
  'Chocolate Dosa': 12.49,
  'Chettinad Spicy Masala Cheese Dosa': 14.99,
  'Mixed Vegetable Cheese Dosa': 15.49,
  'Palak Paneer Cheese Dosa': 15.49,
  'Paneer Butter Cheese Masala Dosa': 15.49,
  // MILLET DOSAS & MILLET MENU
  'Millet Plain Dosa': 10.75,
  'Millet Masala Dosa': 11.49,
  'Millet Onion Dosa': 10.99,
  'Millet Onion Masala Dosa': 11.99,
  'Millet Idly': 7.99,
  'Millet Pongal': 10.75,
  'Millet Kichidi': 10.75,
  'Millet Bisbilebath': 11.49,
  'Millet Bagalabath': 11.49,
  'Millet Vegetable Pulao': 13.49,
  'Millet Chapathi': 11.25,
  'Millet Poori': 11.75,
  'Millet Combo 1': 14.49,
  'Millet Extra Poori': 4.25,
  // UTHAPPAMS
  'Plain Uthappam': 10.99,
  'Onion Uthappam': 11.99,
  'Onion Chilli Uthappam': 12.49,
  'Onion & Peas Uthappam': 12.99,
  'Tomato Uthappam': 11.99,
  'Tomato & Onion Uthappam': 12.49,
  'Tomato & Peas Uthappam': 10.99,
  'Tomato Onion Chilli Uthappam': 12.99,
  'Tomato Peas Onion Uthappam': 12.99,
  'Peas Uthappam': 11.99,
  'Peas Chilli Uthappam': 12.49,
  'Masala Podi Uthappam': 11.99,
  'Ghee Podi Uthappam': 12.49,
  'Cheese Uthappam': 11.99,
  'Chilli Cheese Uthappam': 12.49,
  // TONGUE TICKLERS (House Specials)
  'Adai Avial': 14.49,
  'Appam': 12.49,
  'Idiappam': 12.49,
  'Channa Batura': 14.49,
  // RICE MENU
  'Bagalabath': 10.49,
  'Bisibelabath': 10.49,
  'Executive Meal': 14.49,
  'Rice of the Day': 10.99,
  // BIRYANIS & PULAO
  'Jeera Pulao': 12.99,
  'Peas Pulao': 13.49,
  'Mushroom Pulao': 13.49,
  'Vegetable Pulao': 13.49,
  'Cashew Nut Pulao': 14.99,
  'Paneer Pulao': 13.99,
  'Vegetable Biryani': 13.49,
  'Mushroom Biryani': 14.99,
  'Paneer Biryani': 15.49,
  'Mushroom Mutter': 16.99,
  // FRIED RICE
  'Veg Fried Rice': 13.99,
  'Schezwan Veg Fried Rice': 14.99,
  'Schezwan Paneer Fried Rice': 16.99,
  'Paneer Veg Fried Rice': 15.99,
  // NORTH INDIAN CURRIES
  'Channa Masala': 13.49,
  'Avial': 11.49,
  'Mushroom Rogan Josh': 12.49,
  'Vegetable Butter Masala': 14.49,
  'Veg Jalfrezi': 14.49,
  'Palak Paneer': 14.99,
  'Aloo Gobi Masala': 16.49,
  'Aloo Mutter': 16.49,
  'Aloo Pepper Fry': 16.49,
  'Gobi Masala': 16.49,
  'Gobi Mutter': 16.49,
  'Green Peas Masala': 16.49,
  'Mutter Paneer': 16.99,
  'Kadai Paneer': 17.49,
  'Paneer Butter Masala': 17.99,
  // CHINESE STARTERS
  'Gobi 65': 13.49,
  'Gobi Manchurian': 13.49,
  'Chilli Mushroom': 13.49,
  'Mushroom Manchurian': 13.99,
  'Veg Manchurian': 13.99,
  'Chilly Paneer': 15.49,
  'Paneer Manchurian': 15.99,
  // COMBO MENU
  'Combo 1': 13.99,
  'Combo 2': 13.99,
  'Combo 3': 13.99,
  'Combo 4': 12.49,
  // BREADS
  'Chapathi (2)': 9.99,
  'Poori (2)': 10.49,
  'Parotta (2)': 11.99,
  'Plain Naan': 4.99,
  'Butter Naan': 4.99,
  'Garlic Naan': 4.99,
  // SECOND SERVINGS
  'Extra Chapathi': 3.99,
  'Extra Poori': 3.99,
  'Extra Parotta': 4.49,
  'Rice': 2.99,
  'Extra Ghee': 1.99,
  'Milagaipodi': 2.49,
  // DESSERTS
  'Sweet Pongal': 6.49,
  'Gulab Jamun': 6.49,
  'Rasamalai': 6.49,
  'Badam Kheer': 6.49,
  'Desert of the Day': 7.49,
  'Rava Kesari': 7.99,
  'Badam Halwa': 9.49,
  // BEVERAGES
  'Soft Drinks': 2.00,
  'Special Milk Tea': 3.99,
  'Butter Milk': 4.99,
  'Madras Filter Coffee': 4.99,
  'Mango Juice': 5.49,
  'Lassi': 5.49,
  'Mango Lassi': 6.49
};

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

  const { action, itemName, quantity, notes } = args;

  // Red Team #12 — Use authoritative PRICE_MAP price. Ignore whatever Gemini
  // passed as price to prevent hallucinated totals at checkout.
  const correctPrice = PRICE_MAP[itemName] !== undefined
    ? PRICE_MAP[itemName]
    : args.price; // Fallback to Gemini's price only if item not in map

  if (PRICE_MAP[itemName] === undefined) {
    console.warn(`PRICE_MAP miss for: "${itemName}" — using Gemini price $${args.price}`);
  }

  if (action === 'add') {
    // If item already in cart, update quantity instead of duplicating
    const existing = session.cart.find(i => i.itemName === itemName);
    if (existing) {
      existing.quantity = quantity;
      existing.price = correctPrice; // Also correct price on update
      existing.notes = notes || existing.notes;
    } else {
      session.cart.push({ itemName, quantity, price: correctPrice, notes: notes || '' });
    }
    console.log(`Cart [${callSid}]: Added ${quantity}x ${itemName} @ $${correctPrice}`);
  } else if (action === 'remove') {
    session.cart = session.cart.filter(i => i.itemName !== itemName);
    console.log(`Cart [${callSid}]: Removed ${itemName}`);
  }

  // Log current cart state after every change
  const subtotal = session.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  console.log(`Cart subtotal: $${subtotal.toFixed(2)} | Items: ${session.cart.length}`);

  return { result: 'Cart updated successfully.' };
}

// ── Red Team #14 — Retry helper ───────────────────────────────────────────
// Wraps an async function with up to maxRetries attempts, 1s delay between each.

async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        console.warn(`Supabase write attempt ${attempt} failed: ${err.message} — retrying in ${delayMs}ms`);
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
  }
  throw lastErr;
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
    // Red Team #14 — Wrap the entire Supabase write block in a retry loop.
    // A single network glitch should not lose the order permanently.
    const result = await withRetry(async () => {
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
        // Throw so withRetry can retry this attempt
        throw new Error(`Order insert failed: ${orderErr.message}`);
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

      return { order, orderNumber, total };
    });

    // 6. Clear cart after successful order (outside retry so it only happens once)
    session.cart = [];

    return {
      result: `Order confirmed successfully. Order number is ${result.orderNumber}.`,
      orderId: result.order.id,
      orderNumber: result.orderNumber,
      total: result.total
    };

  } catch (err) {
    // All 3 retry attempts failed
    console.error('handleCompleteOrder failed after 3 attempts:', err.message);
    return {
      result: 'I am sorry, there is a brief system issue. Your order has been noted. ' +
              'Please call us back in 2 minutes and we will get it placed immediately.',
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
