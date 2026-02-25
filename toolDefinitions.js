// toolDefinitions.js
// Gemini function declarations for manageOrder and completeOrder
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
    'Collect and validate the customer\'s name and phone number. Call this BEFORE ' +
    'completeOrder to ensure you have valid customer information. This function will ' +
    'validate the inputs and store them for the final order confirmation.',
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

const completeOrderTool = {
  name: 'completeOrder',
  description:
    'Finalize and write the order to the database. ' +
    'STRICT PRECONDITIONS — all three must be true before calling this: ' +
    '(1) Customer verbally said yes to the order summary. ' +
    '(2) Customer verbally said their name and you confirmed it back. ' +
    '(3) Customer verbally said their phone number and you read it back digit by digit and they confirmed it. ' +
    'NEVER call this with a guessed, assumed, or placeholder name or number. ' +
    'NEVER use the caller ID as the phone number. ' +
    'If you do not yet have both values from the customer\'s own mouth, ask for them first.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: {
        type: Type.STRING,
        description: 'The exact name the customer said out loud for their pickup order.'
      },
      phoneNumber: {
        type: Type.STRING,
        description: 'The phone number the customer said out loud and confirmed. Digits only, no dashes.'
      }
    },
    required: ['customerName', 'phoneNumber']
  }
};

const tools = [{ functionDeclarations: [manageOrderTool, collectCustomerDetailsTool, completeOrderTool] }];

module.exports = { tools };
