import { ReservationLedger } from '../../components/booking/ReservationLedger'
import { hqBookingApi } from '../../utils/bookingApi'
import { hqCustomerApi } from '../../utils/customerApi'
import { hqGinpayApi } from '../../utils/ginpayApi'

export function HqReservationScreen() {
  return <ReservationLedger api={hqBookingApi} customers={hqCustomerApi} ginpay={hqGinpayApi} bottomGap={24} />
}
