'use server'

import { saveCredentials, clearCredentials, setSetting } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function updateSettings(formData: FormData) {
  const user = formData.get('login') as string;
  const pass = formData.get('password') as string;
  if (user && pass) saveCredentials(user, pass);

  const brandName = (formData.get('brand_name') as string)?.trim();
  const brandLogoUrl = (formData.get('brand_logo_url') as string)?.trim();

  if (brandName !== undefined) setSetting('brand_name', brandName);
  if (brandLogoUrl !== undefined) setSetting('brand_logo_url', brandLogoUrl);

  revalidatePath('/dashboard/settings');
}

export async function deleteCredentials() {
  clearCredentials();
  revalidatePath('/dashboard');
  redirect('/dashboard/settings');
}
