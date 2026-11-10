// Guarded by middleware.ts: its matcher lists /appointments, so no check is repeated here.
export default function Appointments() {
  return <h1>Your appointments</h1>;
}
