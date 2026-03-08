// cloverClient.js
// Mirrors the lazy-init pattern from supabaseClient.js.
// Only used when completeOrder fires — same as Supabase.

const CLOVER_BASE = 'https://apisandbox.dev.clover.com/v3';

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

    // 1. Create the order
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

    // 2. Add line items one by one
    for (const item of cart) {
        await fetch(`${CLOVER_BASE}/merchants/${merchantId}/orders/${cloverOrderId}/line_items`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: item.itemName,
                price: Math.round(item.price * 100), // Clover uses cents
                unitQty: item.quantity * 1000         // Clover unitQty = qty × 1000
            })
        });
    }

    console.log(`✓ Clover order created: ${cloverOrderId} for ${customerName}`);
    return cloverOrderId;
}

module.exports = { pushOrderToClover };