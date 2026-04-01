-- Enable RLS + global read policy for gamma tables
-- Applied via Supabase SQL editor on 2026-04-01. Kept for reference only.

ALTER TABLE public.gamma_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gamma_levels   ENABLE ROW LEVEL SECURITY;

-- Allow anyone (including anonymous/unauthenticated) to SELECT
CREATE POLICY "allow_public_read" ON public.gamma_exposure
  FOR SELECT USING (true);

CREATE POLICY "allow_public_read" ON public.gamma_levels
  FOR SELECT USING (true);
