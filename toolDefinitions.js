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

const completeOrderTool = {
  name: 'completeOrder',
  description:
    'Finalize and confirm the order. Call this ONLY after the customer has ' +
    'said yes to the order confirmation AND provided their name and phone number. ' +
    'This writes the order to the database. ' +
    'Do not call this until you have BOTH name and phone number.',
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

const tools = [{ functionDeclarations: [manageOrderTool, completeOrderTool] }];

module.exports = { tools };
