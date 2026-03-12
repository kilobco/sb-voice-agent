// cloverClient.js
// Handles all communication with the Clover POS API.
// Mirrors the lazy-init pattern from supabaseClient.js.
// Only called when completeOrder fires — same lifecycle as Supabase writes.

const CLOVER_BASE = process.env.CLOVER_BASE_URL || 'https://api.clover.com/v3';

function getCloverConfig() {
  if (!process.env.CLOVER_API_TOKEN || !process.env.CLOVER_MERCHANT_ID) {
    throw new Error('CLOVER_API_TOKEN or CLOVER_MERCHANT_ID is not set in env.');
  }
  return {
    token: process.env.CLOVER_API_TOKEN,
    merchantId: process.env.CLOVER_MERCHANT_ID
  };
}

async function pushOrderToClover(cart, customerName, total) {
  const { token, merchantId } = getCloverConfig();

  const orderRes = await fetch(`${CLOVER_BASE}/merchants/${merchantId}/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: `Phone Order — ${customerName}`,
      note: `Voice agent order for ${customerName}`,
      state: 'open'
    })
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    throw new Error(`Clover order create failed: ${err}`);
  }

  const cloverOrder = await orderRes.json();
  const cloverOrderId = cloverOrder.id;

  for (const item of cart) {
    const lineRes = await fetch(
      `${CLOVER_BASE}/merchants/${merchantId}/orders/${cloverOrderId}/line_items`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: item.itemName,
          price: Math.round(item.price * 100),
          unitQty: item.quantity * 1000
        })
      }
    );

    if (!lineRes.ok) {
      const err = await lineRes.text();
      console.error(`Clover line item failed for "${item.itemName}": ${err}`);
    }
  }

  console.log(`✓ Clover order pushed: ${cloverOrderId} | Customer: ${customerName} | Total: $${total}`);
  return cloverOrderId;
}

module.exports = { pushOrderToClover };
