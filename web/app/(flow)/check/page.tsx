import CheckScreen from "@/components/flow/check/CheckScreen";

// Static, so it can be prefetched and saved for offline use; CheckScreen reads ?demo=rowan on the
// device.
export default function CheckPage() {
  return <CheckScreen />;
}
