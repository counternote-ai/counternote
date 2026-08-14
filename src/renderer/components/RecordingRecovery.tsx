import React, { useState, useRef, useCallback } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import type { RecoveryItemView } from '../native-capture-view-model';

interface RecordingRecoveryProps {
  notice: string;
  items: RecoveryItemView[];
  onRecover: (id: string) => void;
  onTrash: (id: string) => void;
  disabled?: boolean;
}

export function RecordingRecovery({
  notice,
  items,
  onRecover,
  onTrash,
  disabled = false,
}: RecordingRecoveryProps) {
  const [confirmTrashId, setConfirmTrashId] = useState<string | null>(null);
  const lastFocusedRef = useRef<HTMLButtonElement | null>(null);

  const handleTrashRequest = useCallback((id: string, button: HTMLButtonElement) => {
    lastFocusedRef.current = button;
    setConfirmTrashId(id);
  }, []);

  const handleConfirmTrash = useCallback(() => {
    if (confirmTrashId !== null) {
      onTrash(confirmTrashId);
      setConfirmTrashId(null);
    }
  }, [confirmTrashId, onTrash]);

  const handleCancelTrash = useCallback(() => {
    setConfirmTrashId(null);
    // Restore focus to the button that initiated the confirmation
    lastFocusedRef.current?.focus();
  }, []);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">Recover recordings</h2>
          <p className="text-xs text-muted-foreground">{notice}</p>
          <p className="text-xs text-muted-foreground">
            Partial recordings are stored locally until you recover or remove them.
          </p>
        </div>

        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium text-foreground">{item.dateLabel}</p>
                <p className="text-xs text-muted-foreground">{item.sizeLabel}</p>
                <p className="text-xs text-muted-foreground">{item.stateLabel}</p>
              </div>

              <div className="flex items-center gap-2">
                {item.state === 'recoverable' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRecover(item.id)}
                    disabled={disabled}
                    aria-label={`Recover recording from ${item.dateLabel}`}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Recover
                  </Button>
                )}

                {item.state === 'recovering' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    aria-label={`Recovering recording from ${item.dateLabel}`}
                  >
                    <RotateCcw className="h-3 w-3 animate-spin" />
                    Recovering
                  </Button>
                )}

                {confirmTrashId === item.id ? (
                  <div
                    className="flex items-center gap-1"
                    role="alertdialog"
                    aria-label="Confirm removal"
                  >
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleConfirmTrash}
                      aria-label="Confirm remove"
                    >
                      Remove
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelTrash}
                      aria-label="Cancel removal"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : item.state !== 'recovering' ? (
                  <Button
                    ref={lastFocusedRef}
                    variant="ghost"
                    size="sm"
                    onClick={(e) => handleTrashRequest(item.id, e.currentTarget)}
                    disabled={disabled}
                    aria-label={`Remove recording from ${item.dateLabel}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
