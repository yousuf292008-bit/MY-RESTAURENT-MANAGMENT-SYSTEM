require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Allow requests from Netlify, Railway, localhost, file:// (null origin), and any ALLOWED_ORIGINS env var
const extraOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : [];
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g. mobile apps, Postman, curl)
    if (!origin) return callback(null, true);
    // Allow file:// protocol (origin comes as the string 'null')
    if (origin === 'null') return callback(null, true);
    // Allow localhost for local dev
    if (origin.startsWith('http://localhost') || origin.startsWith('https://localhost')) return callback(null, true);
    // Allow any Netlify subdomain
    if (origin.endsWith('.netlify.app') || origin === 'https://app.netlify.com') return callback(null, true);
    // Allow any Railway subdomain
    if (origin.endsWith('.railway.app')) return callback(null, true);
    // Allow any explicitly listed origins
    if (extraOrigins.includes(origin)) return callback(null, true);
    // Block everything else
    callback(new Error('CORS: origin ' + origin + ' not allowed'));
  },
  credentials: true
}));

app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================
// 1. AUTHENTICATION
// ==========================

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 1. Sign up user in Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (authError) return res.status(400).json({ error: authError.message });
  if (!authData.user) return res.status(400).json({ error: 'Failed to create user' });

  // 2. Insert into public.users table
  const { data: userData, error: dbError } = await supabase
    .from('users')
    .insert([{ id: authData.user.id, name, email, role }])
    .select()
    .single();

  if (dbError) return res.status(400).json({ error: dbError.message });

  res.status(201).json({ message: 'User created successfully', user: userData });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError) return res.status(401).json({ error: authError.message });

  // Get user details from public.users
  const { data: userData, error: dbError } = await supabase
    .from('users')
    .select('*')
    .eq('id', authData.user.id)
    .single();

  if (dbError) return res.status(400).json({ error: dbError.message });

  res.json({ message: 'Login successful', session: authData.session, user: userData });
});


// ==========================
// 2. MENU MANAGEMENT
// ==========================

// Get all menu items
app.get('/api/menu', async (req, res) => {
  const { data, error } = await supabase.from('menu_items').select('*').order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Add menu item (Admin only logic normally, keeping it simple for now)
app.post('/api/menu', async (req, res) => {
  const { name, description, price, category, type, image_url, is_available, is_popular } = req.body;
  const { data, error } = await supabase
    .from('menu_items')
    .insert([{ name, description, price, category, type, image_url, is_available, is_popular }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// Edit menu item
app.put('/api/menu/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const { data, error } = await supabase
    .from('menu_items')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Delete menu item
app.delete('/api/menu/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('menu_items').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Menu item deleted successfully' });
});


const crypto = require('crypto');
const Razorpay = require('razorpay');

// Initialize Razorpay
// Note: You must add these keys to your .env file
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_HERE',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET_HERE',
});

// ==========================
// 3. ORDERS & PAYMENTS
// ==========================

// Create Order (with items)
app.post('/api/orders', async (req, res) => {
  const { customer_id, table_no, items, payment_method, points_redeemed, spin_reward_applied, booking_id, checkout_spin_reward } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain items' });
  }

  // Calculate total amount in INR including customizations
  const subtotalBeforeDiscounts = items.reduce((sum, item) => {
    let itemPrice = item.price;
    if (item.customizations) {
      if (item.customizations.extraCheese) itemPrice += 20;
      if (item.customizations.extraPaneer) itemPrice += 30;
      if (item.customizations.extraSauce) itemPrice += 15;
    }
    return sum + (itemPrice * item.quantity);
  }, 0);

  // Apply Reward Points discount
  let pointsDeducted = 0;
  let rewardDiscount = 0;
  if (customer_id && points_redeemed > 0) {
    const { data: user, error: userErr } = await supabase.from('users').select('reward_points').eq('id', customer_id).single();
    if (!userErr && user && user.reward_points >= points_redeemed) {
      pointsDeducted = points_redeemed;
      if (points_redeemed === 100) {
        rewardDiscount = 50;
      } else if (points_redeemed === 200) {
        const drinks = items.filter(it => it.category === 'drinks');
        rewardDiscount = drinks.length > 0 ? Math.max(...drinks.map(d => d.price)) : 100;
      } else if (points_redeemed === 500) {
        const mains = items.filter(it => it.category === 'maincourse');
        rewardDiscount = mains.length > 0 ? Math.max(...mains.map(m => m.price)) : 250;
      }
    }
  }

  // Apply Spin Wheel reward discount
  let spinDiscount = 0;
  if (customer_id && spin_reward_applied) {
    if (booking_id) {
      const { data: booking, error: bkErr } = await supabase.from('bookings').select('*').eq('id', booking_id).single();
      if (!bkErr && booking && booking.customer_id === customer_id && booking.spin_completed && booking.spin_reward) {
        const reward = booking.spin_reward;
        if (reward === '5% Discount') {
          spinDiscount += subtotalBeforeDiscounts * 0.05;
        } else if (reward === '10% Discount') {
          spinDiscount += subtotalBeforeDiscounts * 0.10;
        } else if (reward === '15% Discount') {
          spinDiscount += subtotalBeforeDiscounts * 0.15;
        } else if (reward === 'Free Soft Drink') {
          const drinks = items.filter(it => it.category === 'drinks');
          spinDiscount += drinks.length > 0 ? Math.max(...drinks.map(d => d.price)) : 80;
        } else if (reward === 'Free Dessert') {
          const desserts = items.filter(it => it.category === 'desserts');
          spinDiscount += desserts.length > 0 ? Math.max(...desserts.map(d => d.price)) : 120;
        }
      }
    }
    if (checkout_spin_reward) {
      const reward = checkout_spin_reward;
      if (reward === '20% Discount') {
        spinDiscount += subtotalBeforeDiscounts * 0.20;
      } else if (reward === '15% Discount') {
        spinDiscount += subtotalBeforeDiscounts * 0.15;
      }
      // Note: '20 pts Reward' has no discount value, it only adds reward points
    }
  }

  const final_subtotal = Math.max(0, subtotalBeforeDiscounts - rewardDiscount - spinDiscount);
  const gst = final_subtotal * 0.05;
  const final_total = final_subtotal + gst;

  // Query max ID to enable self-healing reset order ID starting from 1
  let nextOrderId = null;
  const { data: maxOrders, error: maxOrderError } = await supabase
    .from('orders')
    .select('id')
    .order('id', { ascending: false })
    .limit(1);
    
  if (!maxOrderError) {
    const lastId = (maxOrders && maxOrders.length > 0) ? maxOrders[0].id : 0;
    nextOrderId = lastId + 1;
  }

  // 1. Insert Order into Supabase
  const insertData = {
    customer_id,
    table_no,
    status: 'Pending',
    total_amount: final_total,
    payment_method: payment_method || 'Cash',
    payment_status: payment_method === 'Online' ? 'Pending' : 'Unpaid'
  };
  if (nextOrderId !== null) {
    insertData.id = nextOrderId;
  }

  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .insert([insertData])
    .select()
    .single();

  if (orderError) return res.status(400).json({ error: orderError.message });

  // 2. Insert Order Items
  const orderItems = items.map(item => ({
    order_id: orderData.id,
    menu_item_id: item.menu_item_id,
    quantity: item.quantity,
    price: item.price,
    customizations: item.customizations || null
  }));

  const { error: itemsError } = await supabase.from('order_items').insert(orderItems);
  if (itemsError) return res.status(400).json({ error: itemsError.message });

  // Deduct points/save discount for Cash orders instantly (For Online, we do this in confirmUpiPayment or verify)
  if (payment_method !== 'Online' && customer_id) {
    if (pointsDeducted > 0) {
      const { data: user } = await supabase.from('users').select('reward_points, saved_through_rewards').eq('id', customer_id).single();
      if (user) {
        await supabase.from('users').update({
          reward_points: Math.max(0, user.reward_points - pointsDeducted),
          saved_through_rewards: parseFloat(user.saved_through_rewards || 0) + rewardDiscount
        }).eq('id', customer_id);
        await supabase.from('points_history').insert([{
          user_id: customer_id,
          points: -pointsDeducted,
          reason: `Redeemed points for Order #${orderData.id}`
        }]);
      }
    }
    if (spinDiscount > 0) {
      const { data: user } = await supabase.from('users').select('saved_through_rewards').eq('id', customer_id).single();
      if (user) {
        await supabase.from('users').update({
          saved_through_rewards: parseFloat(user.saved_through_rewards || 0) + spinDiscount
        }).eq('id', customer_id);
      }
      if (booking_id) {
        await supabase.from('bookings').update({ spin_completed: true }).eq('id', booking_id);
      }
    }
  }

  // 3. If Online Payment, generate Razorpay Order
  if (payment_method === 'Online') {
    try {
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(final_total * 100), // Amount in paise
        currency: 'INR',
        receipt: `receipt_order_${orderData.id}`,
      });
      return res.status(201).json({
        message: 'Order created',
        order: orderData,
        razorpay_order: rzpOrder,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } catch (err) {
      console.error('Razorpay Error:', err);
      return res.status(500).json({ error: 'Failed to create payment gateway order' });
    }
  }

  // Return standard response for Cash
  if (payment_method !== 'Online') {
    await awardPointsForOrder(orderData.id, true);
  }
  res.status(201).json({ message: 'Order placed successfully', order: orderData });
});

// Verify Payment Signature
app.post('/api/payment/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body;
  const secret = process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET_HERE';

  // Verify Signature
  const shasum = crypto.createHmac('sha256', secret);
  shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
  const digest = shasum.digest('hex');

  if (digest === razorpay_signature) {
    // Payment Successful - Update Database
    const { data, error } = await supabase
      .from('orders')
      .update({ payment_status: 'Paid', payment_id: razorpay_payment_id })
      .eq('id', order_id);

    if (error) {
      return res.status(500).json({ status: 'Payment successful but DB update failed', error: error.message });
    }
    
    // Award points on online order confirmation
    await awardPointsForOrder(order_id, true);

    res.json({ status: 'ok', message: 'Payment verified successfully' });
  } else {
    res.status(400).json({ status: 'error', message: 'Invalid signature' });
  }
});

// Get all orders (for admin dashboard)
app.get('/api/orders', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      order_items ( *, menu_items(*) ),
      users ( name )
    `)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Helper function to award points on order confirmation or completion
async function awardPointsForOrder(orderId, ignoreStatus = false) {
  try {
    const reasonText = `Earned from Order #${orderId}`;
    const { data: existingHistory } = await supabase
      .from('points_history')
      .select('id')
      .eq('reason', reasonText)
      .limit(1);
    if (existingHistory && existingHistory.length > 0) return; // already awarded

    const { data: orderData } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();
    if (!orderData || !orderData.customer_id) return;
    if (!ignoreStatus && orderData.status !== 'Completed') return;

    const orderTotal = parseFloat(orderData.total_amount);
    const pointsEarned = Math.floor(orderTotal / 100) * 10;
    if (pointsEarned <= 0) return;

    const { data: user } = await supabase
      .from('users')
      .select('reward_points')
      .eq('id', orderData.customer_id)
      .single();
    if (user) {
      const newPoints = (user.reward_points || 0) + pointsEarned;
      await supabase.from('users').update({ reward_points: newPoints }).eq('id', orderData.customer_id);
      await supabase.from('points_history').insert([{
        user_id: orderData.customer_id,
        points: pointsEarned,
        reason: reasonText
      }]);
      console.log(`Awarded ${pointsEarned} points to user ${orderData.customer_id} for order #${orderId}`);
    }
  } catch (err) {
    console.error("Error awarding points:", err);
  }
}

// Update order status
app.put('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  if (status === 'Completed') {
    await awardPointsForOrder(id, false);
  }

  res.json(data);
});


// ==========================
// 4. BILLING (Checkout)
// ==========================

// Generate Bill
app.post('/api/checkout', async (req, res) => {
  const { order_id } = req.body;

  // Fetch the order
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', order_id)
    .single();

  if (orderError) return res.status(400).json({ error: orderError.message });
  if (!orderData) return res.status(404).json({ error: 'Order not found' });

  // Calculate taxes (e.g. 5% GST)
  const subtotal = parseFloat(orderData.total_amount);
  const gst = subtotal * 0.05;
  const total = subtotal + gst;

  // Insert Bill
  const { data: billData, error: billError } = await supabase
    .from('bills')
    .insert([{ order_id, subtotal, gst, total }])
    .select()
    .single();

  if (billError) return res.status(400).json({ error: billError.message });

  // Update order status to completed
  await supabase.from('orders').update({ status: 'Completed' }).eq('id', order_id);

  // Award reward points for the completed order
  await awardPointsForOrder(order_id, false);

  res.status(201).json({ message: 'Checkout successful, bill generated', bill: billData });
});

// ==========================
// 5. BOOKINGS & SPIN WHEEL & CUSTOMER DASHBOARD
// ==========================

// Create Booking
app.post('/api/bookings', async (req, res) => {
  const { customer_id, table_no, booking_date, booking_time, guests_count } = req.body;
  if (!customer_id || !table_no || !booking_date || !booking_time || !guests_count) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  // Initialize a custom user client for Supabase to enforce the user's RLS policy context during insertion
  const userSupabase = token
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        },
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      })
    : supabase;

  // 1. Insert as 'Pending' first to satisfy Supabase RLS insert policies (using userSupabase client context)
  const { data, error } = await userSupabase
    .from('bookings')
    .insert([{ customer_id, table_no, booking_date, booking_time, guests_count, status: 'Pending' }])
    .select()
    .single();

  if (error) {
    console.error('Booking insert failed:', error);
    return res.status(400).json({ error: error.message });
  }

  // 2. Try to update to 'Approved' (failsafe fallback if RLS blocks status updates)
  const { data: updatedData, error: updateError } = await supabase
    .from('bookings')
    .update({ status: 'Approved' })
    .eq('id', data.id)
    .select()
    .single();

  if (updateError) {
    console.warn('Auto-approval update failed (RLS constraint):', updateError.message);
    // Return the successfully inserted pending row instead of throwing an error
    return res.status(201).json(data);
  }

  res.status(201).json(updatedData);
});

// Get Bookings
app.get('/api/bookings', async (req, res) => {
  const { customer_id } = req.query;
  let query = supabase.from('bookings').select(`
    *,
    users ( name, email )
  `).order('created_at', { ascending: false });

  if (customer_id) {
    query = query.eq('customer_id', customer_id);
  }

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Update Booking Status
app.put('/api/bookings/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const { data, error } = await supabase
    .from('bookings')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Spin Reward Save
app.post('/api/bookings/:id/spin', async (req, res) => {
  const { id } = req.params;
  const { reward } = req.body;

  if (!reward) return res.status(400).json({ error: 'Reward is required' });

  const { data: booking, error: fetchErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'Approved') return res.status(400).json({ error: 'Only approved bookings can access the spin wheel' });
  if (booking.spin_completed) return res.status(400).json({ error: 'Multiple spins are not allowed for the same booking' });

  const { data, error } = await supabase
    .from('bookings')
    .update({ spin_completed: true, spin_reward: reward })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Get User Dashboard Data
app.get('/api/users/:id/dashboard', async (req, res) => {
  try {
    const { id } = req.params;

    let { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (userErr || !user) {
      // Fallback placeholder instead of returning 404 user not found
      user = {
        id: id,
        name: 'Customer',
        email: 'customer@everdine.com',
        role: 'Customer',
        reward_points: 0,
        saved_through_rewards: 0
      };
    }

    const { data: ordersData, error: ordersErr } = await supabase
      .from('orders')
      .select('total_amount, status, payment_status')
      .eq('customer_id', id);

    let totalOrders = 0;
    let totalSpent = 0;

    if (!ordersErr && ordersData) {
      totalOrders = ordersData.length;
      totalSpent = ordersData
        .filter(o => o.status !== 'Cancelled')
        .reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);
    }

    const { data: bookingsData } = await supabase
      .from('bookings')
      .select('*')
      .eq('customer_id', id)
      .order('created_at', { ascending: false });

    const { data: pointsHistory } = await supabase
      .from('points_history')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false });

    const points = user.reward_points || 0;
    let membershipLevel = 'Bronze';
    if (points >= 500) membershipLevel = 'Platinum';
    else if (points >= 300) membershipLevel = 'Gold';
    else if (points >= 100) membershipLevel = 'Silver';

    res.json({
      user: {
        name: user.name,
        email: user.email,
        reward_points: points,
        saved_through_rewards: parseFloat(user.saved_through_rewards || 0),
        membership_level: membershipLevel
      },
      stats: {
        total_orders: totalOrders,
        total_spent: totalSpent
      },
      bookings: bookingsData || [],
      points_history: pointsHistory || []
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint (keep /health only so '/' can serve the frontend)
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'Everdine backend is running' }));

// Serve frontend for all non-API routes (SPA fallback)
app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: function (res, path) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
}));
app.get('/{*any}', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 5000;

// Validate required environment variables
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ MISSING ENVIRONMENT VARIABLES:', missing.join(', '));
  console.error('Please set these in Railway → Settings → Variables');
} else {
  console.log('✅ All environment variables present');
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
