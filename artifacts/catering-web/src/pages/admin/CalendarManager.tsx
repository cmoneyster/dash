import { useState } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { 
  useListBlackoutDates, 
  useCreateBlackoutDate, 
  useDeleteBlackoutDate,
  getListBlackoutDatesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";

export default function CalendarManager() {
  const queryClient = useQueryClient();
  const { data: blackoutDates } = useListBlackoutDates();
  
  const createMut = useCreateBlackoutDate({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListBlackoutDatesQueryKey() }) }
  });
  
  const deleteMut = useDeleteBlackoutDate({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListBlackoutDatesQueryKey() }) }
  });

  const disabledDays = blackoutDates?.map(b => {
    // API returns dates like "2024-12-25", split carefully to avoid timezone shift
    const [y, m, d] = b.date.split('-');
    return new Date(parseInt(y), parseInt(m)-1, parseInt(d));
  }) || [];

  const handleDayClick = (day: Date) => {
    // Formulate YYYY-MM-DD
    const dateStr = format(day, 'yyyy-MM-dd');
    const existing = blackoutDates?.find(b => b.date === dateStr);

    if (existing) {
      if (confirm(`Remove blackout date for ${dateStr}?`)) {
        deleteMut.mutate({ id: existing.id });
      }
    } else {
      const reason = prompt(`Block out ${dateStr}? Enter reason (optional):`);
      if (reason !== null) { // if not cancelled
        createMut.mutate({ data: { date: dateStr, reason } });
      }
    }
  };

  return (
    <AdminLayout>
      <div className="mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Availability Calendar</h1>
        <p className="text-muted-foreground">Click a date to toggle its availability. Blackout dates prevent customers from booking events.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
        <div className="bg-card p-8 rounded-3xl border border-border shadow-sm flex justify-center items-center">
          <DayPicker
            mode="multiple"
            selected={disabledDays}
            onDayClick={handleDayClick}
            modifiers={{ blocked: disabledDays }}
            modifiersStyles={{
              blocked: { color: 'hsl(var(--destructive))', fontWeight: 'bold', textDecoration: 'line-through' }
            }}
            className="scale-125 origin-center"
          />
        </div>

        <div>
          <h3 className="font-bold text-xl mb-4">Current Blackout Dates</h3>
          <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
            {blackoutDates?.length === 0 ? (
              <p className="p-6 text-muted-foreground text-center">No blackout dates set.</p>
            ) : (
              <ul className="divide-y divide-border">
                {blackoutDates?.map(b => (
                  <li key={b.id} className="p-4 flex justify-between items-center hover:bg-secondary/30">
                    <div>
                      <span className="font-semibold text-destructive">{b.date}</span>
                      {b.reason && <span className="text-sm text-muted-foreground ml-3">— {b.reason}</span>}
                    </div>
                    <button 
                      onClick={() => deleteMut.mutate({ id: b.id })}
                      className="text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
