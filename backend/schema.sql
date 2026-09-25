-- Supabase Schema for Everdine Restaurant

-- 1. Users Table (Extends Supabase auth.users)
CREATE TABLE public.users (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Admin', 'Customer')),
  reward_points INTEGER DEFAULT 0,
  saved_through_rewards NUMERIC(10, 2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- 2. Menu Items Table
CREATE TABLE public.menu_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('veg', 'nonveg')) DEFAULT 'veg',
  image_url TEXT,
  is_available BOOLEAN DEFAULT TRUE,
  is_popular BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- 3. Orders Table
CREATE TABLE public.orders (
  id SERIAL PRIMARY KEY,
  customer_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  table_no TEXT,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Preparing', 'Ready', 'Completed', 'Cancelled')) DEFAULT 'Pending',
  total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  payment_method TEXT DEFAULT 'Cash',
  payment_status TEXT DEFAULT 'Unpaid',
  payment_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- 4. Order Items Table
CREATE TABLE public.order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES public.orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES public.menu_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price NUMERIC(10, 2) NOT NULL, -- price at the time of order
  customizations JSONB
);

-- 5. Bills Table
CREATE TABLE public.bills (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES public.orders(id) ON DELETE CASCADE,
  subtotal NUMERIC(10, 2) NOT NULL,
  gst NUMERIC(10, 2) NOT NULL,
  total NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- 6. Table Bookings Table
CREATE TABLE public.bookings (
  id SERIAL PRIMARY KEY,
  customer_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  table_no TEXT NOT NULL,
  booking_date DATE NOT NULL,
  booking_time TIME NOT NULL,
  guests_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected')) DEFAULT 'Pending',
  spin_completed BOOLEAN DEFAULT FALSE,
  spin_reward TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- 7. Reward Points History Table
CREATE TABLE public.points_history (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- 8. Customer Reviews Table
CREATE TABLE public.reviews (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now())
);

-- Enable RLS
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read reviews
CREATE POLICY "Allow public read" ON public.reviews
  FOR SELECT USING (true);

-- Allow anyone to insert reviews
CREATE POLICY "Allow public insert" ON public.reviews
  FOR INSERT WITH CHECK (true);

-- Insert default reviews
INSERT INTO public.reviews (name, rating, text) VALUES
  ('Aarav S.', 5, 'The Butter Chicken here is absolutely phenomenal. Best I''ve had in the city!'),
  ('Priya M.', 4, 'Great ambiance and excellent service. The starters were top-notch.'),
  ('Rohan D.', 5, 'A truly grand dining experience. The Chocolate Lava Cake is a must-try!');
