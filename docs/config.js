// Datos públicos del proyecto de Supabase (no son secretos: la URL y la clave anon/publishable).
// José los copia de Supabase → Project Settings → API.
window.SALA_CONFIG = {
  SUPABASE_URL: "https://srdpcfpqdapdaydhdbjs.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_z7CuNmlbDo4ySZ-1SYyFxg_l1rAQNiN",
  // Fin de turno: silencio que espera la app antes de responder (VAD, cuadros de 96 ms → 14 ≈ 1,3 s).
  // Con 770 ms cortaba a quien hace pausas para pensar en otro idioma (medido: quedó un turno de solo «This is my.»).
  END_OF_TURN_FRAMES: 14,
  // Clave pública de notificaciones (VAPID). La privada vive solo en los secretos de Supabase.
  VAPID_PUBLIC_KEY: "BJt4N4lC0McLC-TxWHGLeyi3pQ-f_igeU8Ar25a7Zv4Xazulql0E534IWGADPce_M6nnHVzsoiVLAaqmI7fdDu8",
};
