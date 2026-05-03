import { supabase } from './supabaseClient.js';

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    await supabase.auth.signOut({ scope: 'local' });
    return null;
  }
  if (!data.session) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    await supabase.auth.signOut({ scope: 'local' });
    return null;
  }

  return {
    ...data.session,
    user: userData.user,
  };
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

export async function fetchCalendars() {
  let { data, error } = await supabase
    .from('calendar_members')
    .select('role, calendars(id, name, color, owner_id, archived_at, created_at)');

  if (error && error.message?.includes('archived_at')) {
    ({ data, error } = await supabase
      .from('calendar_members')
      .select('role, calendars(id, name, color, owner_id, created_at)'));
  }

  if (error) throw error;
  return data
    .map((row) => ({ archived_at: null, ...row.calendars, role: row.role }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export async function createCalendar({ name, color }) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;

  const { data, error } = await supabase
    .from('calendars')
    .insert({ name, color, owner_id: userData.user.id })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteCalendar(id) {
  const { error } = await supabase.from('calendars').delete().eq('id', id);
  if (error) throw error;
}

export async function updateCalendarArchive(id, archived) {
  const { data, error } = await supabase
    .from('calendars')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function fetchTags() {
  const { data, error } = await supabase
    .from('tags')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data;
}

export async function createTag({ name, color }) {
  const { data, error } = await supabase
    .from('tags')
    .insert({ name, color })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateTag(id, { name, color }) {
  const { data, error } = await supabase
    .from('tags')
    .update({ name, color })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteTag(id) {
  const { error } = await supabase.from('tags').delete().eq('id', id);
  if (error) throw error;
}

export async function shareCalendar({ calendar_id, email, role }) {
  const { data, error } = await supabase
    .rpc('share_calendar_by_email', {
      target_calendar_id: calendar_id,
      target_email: email,
      target_role: role,
    });

  if (error) throw error;
  return data;
}

export async function fetchEvents(calendarIds, rangeStart, rangeEnd) {
  if (!calendarIds.length) return [];

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .in('calendar_id', calendarIds)
    .lte('starts_at', rangeEnd.toISOString())
    .gte('ends_at', rangeStart.toISOString())
    .order('starts_at', { ascending: true });

  if (error) throw error;
  return data;
}

export async function saveEvent(event) {
  const payload = {
    calendar_id: event.calendar_id,
    title: event.title,
    description: event.description,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    color: event.color,
    category: event.category,
    tag_id: event.tag_id || null,
    reminder_minutes: event.reminder_minutes,
    completed: Boolean(event.completed),
  };

  if (event.id) {
    const { data, error } = await supabase
      .from('events')
      .update(payload)
      .eq('id', event.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('events')
    .insert(payload)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteEvent(id) {
  const { error } = await supabase.from('events').delete().eq('id', id);
  if (error) throw error;
}

export async function setEventCompleted(id, completed) {
  const { data, error } = await supabase
    .from('events')
    .update({ completed })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export function subscribeToEvents(calendarIds, callback) {
  if (!calendarIds.length) return null;

  const channel = supabase.channel(`events:${calendarIds.sort().join(',')}`);

  calendarIds.forEach((calendarId) => {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'events',
        filter: `calendar_id=eq.${calendarId}`,
      },
      callback,
    );
  });

  channel.subscribe();

  return channel;
}

export async function removeChannel(channel) {
  if (channel) await supabase.removeChannel(channel);
}
