import type { NotificationScope, Observable, Store } from "../core/observable.ts";

/** A disposed controller keeps its last snapshot and rejects new subscriptions. */
export function controllerObservable<T>(cell: Store<T>, name: string, disposed: () => boolean,
    scope?: NotificationScope): Observable<T> {
    return {
        getSnapshot: cell.observable.getSnapshot,
        subscribe(listener) {
            scope?.assertWritable();
            if (disposed()) throw new Error(name + " controller is disposed.");
            return cell.observable.subscribe(listener);
        },
    };
}
