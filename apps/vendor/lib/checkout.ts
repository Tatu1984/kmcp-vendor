import * as React from "react";

import { RazorpayCheckout, type CheckoutResult, type GatewayOrder } from "../components/razorpay-checkout";

/**
 * Opens a Razorpay checkout sheet and resolves once it closes.
 *
 * A screen that starts a gateway payment needs the same three things every
 * time: somewhere to hold the order while the sheet is open, a way to turn
 * "the sheet closed" into a single awaited result, and the `<RazorpayCheckout>`
 * element itself mounted somewhere in the tree. This hook is that, written
 * once, so the session screen reads as one straight line — order, sheet,
 * verify — rather than a state machine spread over callbacks.
 */
export interface CheckoutRequest {
  gatewayKeyId: string;
  gatewayOrder: GatewayOrder;
  description: string;
}

export function useRazorpayCheckout(): {
  open: (request: CheckoutRequest) => Promise<CheckoutResult>;
  modal: React.ReactNode;
} {
  const [request, setRequest] = React.useState<CheckoutRequest | null>(null);
  const resolverRef = React.useRef<((result: CheckoutResult) => void) | null>(null);

  const settle = React.useCallback((result: CheckoutResult) => {
    setRequest(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(result);
  }, []);

  const open = React.useCallback((next: CheckoutRequest): Promise<CheckoutResult> => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setRequest(next);
    });
  }, []);

  const modal = request
    ? React.createElement(RazorpayCheckout, {
        visible: true,
        gatewayKeyId: request.gatewayKeyId,
        gatewayOrder: request.gatewayOrder,
        description: request.description,
        onResult: settle,
        onRequestClose: () => settle({ status: "cancelled" }),
      })
    : null;

  return { open, modal };
}
