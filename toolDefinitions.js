// toolDefinitions.js
// Gemini function declarations for manageOrder, collectCustomerDetails,
// confirmOrder, and completeOrder.
// These schemas tell Gemini when to call a function and what arguments to pass.
// DO NOT rename these functions — Peter 1's server.js depends on exact names.

const { Type } = require('@google/genai');

const manageOrderTool = {
  name: 'manageOrder',
  description:
    'Manage the cart. Call this IMMEDIATELY when the customer adds, ' +
    'updates, or removes an item. Look up the price from the menu in your ' +
    'system instruction and always include it.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        description: "Action to perform: add (adds or updates item) or remove."
      },
      itemName: {
        type: Type.STRING,
        description: 'Exact name of the item from the menu.'
      },
      quantity: {
        type: Type.INTEGER,
        description: 'Quantity of the item. Default to 1 if not specified.'
      },
      price: {
        type: Type.NUMBER,
        description: 'Unit price of the item from the menu. Example: 10.49. REQUIRED.'
      },
      notes: {
        type: Type.STRING,
        description: 'Any special instructions from the customer.'
      }
    },
    required: ['action', 'itemName', 'quantity', 'price']
  }
};

const collectCustomerDetailsTool = {
  name: 'collectCustomerDetails',
  description:
    'Collect and validate the customer\'s name and phone number. ' +
    'You MUST call this BEFORE confirmOrder. This stores the customer ' +
    'details in the session for the final order. ' +
    'NEVER skip this step — completeOrder will reject without it.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: {
        type: Type.STRING,
        description: 'The full name of the customer for pickup.'
      },
      phoneNumber: {
        type: Type.STRING,
        description: 'The phone number of the customer. Include country code if provided.'
      }
    },
    required: ['customerName', 'phoneNumber']
  }
};

const confirmOrderTool = {
  name: 'confirmOrder',
  description:
    'Lock in the order after the customer verbally says YES to the order summary. ' +
    'STRICT SEQUENCE: (1) Read back all items and total to the customer. ' +
    '(2) Ask "Shall I confirm this order?" (3) Customer says yes. ' +
    '(4) Call collectCustomerDetails with their name and phone. ' +
    '(5) Call this confirmOrder tool. (6) Then call completeOrder. ' +
    'NEVER call this before the customer has said yes AND you have collected their details.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const completeOrderTool = {
  name: 'completeOrder',
  description:
    'Finalize and write the order to the database. ' +
    'STRICT PRECONDITIONS — all must be true: ' +
    '(1) collectCustomerDetails was called with the spoken name and confirmed phone number. ' +
    '(2) confirmOrder was called after the customer said yes. ' +
    'This tool takes NO parameters — it reads customer details from the session. ' +
    'If you have not called collectCustomerDetails and confirmOrder first, this will fail.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const tools = [{ functionDeclarations: [manageOrderTool, collectCustomerDetailsTool, confirmOrderTool, completeOrderTool] }];

module.exports = { tools };
